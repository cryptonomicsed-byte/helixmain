import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Icon } from '../components/Icon'
import type { ApprovalItem, AuditEntry } from '../api'

const POLL_MS = 5000

const RISK: Record<string, string> = { low: 'var(--ok)', medium: 'var(--warn)', high: 'var(--bad)' }

/* ── WebAuthn helpers ─────────────────────────────────────────── */
function b64urlToBuf(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}
function bufToB64url(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf); let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** Registration ceremony — returns the attestation the gatekeeper expects. */
async function registerCredential(ccr: any): Promise<unknown> {
  const pk = ccr.publicKey ?? ccr
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: b64urlToBuf(pk.challenge),
    rp: pk.rp,
    user: { ...pk.user, id: b64urlToBuf(pk.user.id) },
    pubKeyCredParams: pk.pubKeyCredParams,
    timeout: pk.timeout,
    attestation: pk.attestation ?? 'none',
    authenticatorSelection: pk.authenticatorSelection ?? { userVerification: 'required', residentKey: 'required' },
  }}) as PublicKeyCredential
  const r: any = cred.response
  return {
    id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type,
    response: {
      attestationObject: bufToB64url(r.attestationObject),
      clientDataJSON: bufToB64url(r.clientDataJSON),
      transports: r.getTransports?.() ?? [],
    },
    extensions: (cred as any).getClientExtensionResults?.() ?? {},
  }
}
/** Run the passkey assertion for a hold and return the credential the gatekeeper expects. */
async function runAssertion(rcr: any): Promise<unknown> {
  const pk = rcr.publicKey ?? rcr
  const allow = (pk.allowCredentials ?? []).map((c: any) => ({
    type: c.type ?? 'public-key', id: b64urlToBuf(c.id), transports: c.transports,
  }))
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBuf(pk.challenge),
      rpId: pk.rpId,
      allowCredentials: allow,
      userVerification: pk.userVerification ?? 'preferred',
      ...(pk.timeout ? { timeout: pk.timeout } : {}),
    },
  }) as PublicKeyCredential
  const r: any = cred.response
  return {
    id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type,
    response: {
      authenticatorData: bufToB64url(r.authenticatorData),
      clientDataJSON: bufToB64url(r.clientDataJSON),
      signature: bufToB64url(r.signature),
      userHandle: r.userHandle ? bufToB64url(r.userHandle) : null,
    },
    extensions: (cred as any).getClientExtensionResults?.() ?? {},
  }
}

function ago(ts: string): string {
  if (!ts) return '—'
  const t = new Date(ts).getTime(); if (Number.isNaN(t)) return '—'
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
function expiresIn(ts?: string): string {
  if (!ts) return ''
  const t = new Date(ts).getTime(); if (Number.isNaN(t)) return ''
  const m = Math.round((t - Date.now()) / 60000)
  if (m <= 0) return 'expired'
  if (m < 60) return `expires in ${m}m`
  return `expires in ${Math.floor(m / 60)}h ${m % 60}m`
}

export function ApprovalsPage() {
  const [pending, setPending] = useState<ApprovalItem[]>([])
  const [audit] = useState<AuditEntry[]>([])
  const [reachable, setReachable] = useState(true)
  const [acting, setActing] = useState<Set<string>>(new Set())
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [enrollMsg, setEnrollMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function poll() {
    try {
      const data = await api.gkQueue()
      setPending(data.pending ?? []); setReachable(true)
    } catch { setReachable(false) }
  }
  useEffect(() => {
    poll()
    timerRef.current = setInterval(poll, POLL_MS)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  async function deny(id: string) {
    setActing((s) => new Set([...s, id])); setNote(null)
    try { await api.gkDeny(id); setNote({ kind: 'ok', text: 'Denied — action blocked.' }); await poll() }
    catch (e) { setNote({ kind: 'bad', text: `Deny failed: ${e instanceof Error ? e.message : String(e)}` }) }
    finally { setActing((s) => { const n = new Set(s); n.delete(id); return n }) }
  }

  async function approve(id: string) {
    setActing((s) => new Set([...s, id])); setNote(null)
    try {
      const rcr = await api.gkChallenge(id)
      const credential = await runAssertion(rcr)
      await api.gkApprove(id, credential)
      setNote({ kind: 'ok', text: 'Approved — receipt minted.' })
      await poll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setNote({ kind: 'bad', text: /NoPasskey|passkey/i.test(msg)
        ? 'Approval needs a registered passkey on this gatekeeper (none registered yet).'
        : `Approve failed: ${msg}` })
    } finally { setActing((s) => { const n = new Set(s); n.delete(id); return n }) }
  }

  async function enroll() {
    setEnrolling(true); setNote(null); setEnrollMsg(null)
    try {
      const ccr = await api.gkSetupChallenge('approver', 'Approver')
      const credential = await registerCredential(ccr)
      await api.gkSetupFinish('approver', credential)
      setEnrollMsg('Passkey enrolled on this device — you can now approve.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const diag = `[secure=${window.isSecureContext} origin=${location.origin} pk=${typeof (window as any).PublicKeyCredential !== 'undefined'}]`
      setEnrollMsg(/40[34]/.test(msg)
        ? 'Enrollment is closed right now (the /setup endpoint is deliberately not published). Ask the operator to open it for enrollment.'
        : `Enroll failed: ${msg} ${diag}`)
    } finally { setEnrolling(false) }
  }

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="reveal" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div>
          <div className="h1">Approvals</div>
          <div className="sub" style={{ marginTop: 4 }}>SparkGatekeeper hold queue · polls every 5s</div>
        </div>
        <span className="pill" style={{ color: reachable ? 'var(--ok)' : 'var(--bad)',
          borderColor: (reachable ? 'var(--ok)' : 'var(--bad)') + '55' }}>
          <span className={`dot ${reachable ? '' : 'dot-bad'}`} style={{ color: reachable ? 'var(--ok)' : 'var(--bad)' }} />
          {reachable ? 'Connected' : 'Unreachable'}
        </span>
      </div>

      {note && (
        <div className="glass reveal" style={{ padding: '0.75rem 1rem', fontSize: '.85rem',
          borderColor: (note.kind === 'ok' ? 'var(--ok)' : 'var(--bad)') + '55',
          color: note.kind === 'ok' ? 'var(--ok)' : 'var(--bad)' }}>
          {note.text}
        </div>
      )}

      {/* Approver passkey (WebAuthn) — required to approve */}
      <div className="glass" style={{ padding: '0.9rem 1.1rem', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '.875rem' }}>Approver passkey</div>
          <div className="sub">WebAuthn is required to approve. Enroll this device once.</div>
          <div className="mono" style={{ fontSize: '.66rem', color: 'var(--fg-3)', marginTop: 4 }}>
            secureContext={String(typeof window !== 'undefined' && window.isSecureContext)}
            {' · '}origin={typeof location !== 'undefined' ? location.origin : '?'}
            {' · '}webauthn={String(typeof window !== 'undefined' && typeof (window as any).PublicKeyCredential !== 'undefined')}
          </div>
        </div>
        <button className="btn" disabled={enrolling} onClick={enroll}>
          <Icon name="check" size={14} /> {enrolling ? 'Enrolling…' : 'Enroll this device'}
        </button>
      </div>
      {enrollMsg && (
        <div className="glass reveal" style={{ padding: '0.7rem 1rem', fontSize: '.84rem',
          color: /enrolled/.test(enrollMsg) ? 'var(--ok)' : 'var(--bad)',
          borderColor: (/enrolled/.test(enrollMsg) ? 'var(--ok)' : 'var(--bad)') + '55' }}>
          {enrollMsg}
        </div>
      )}

      <section>
        <div className="h2" style={{ marginBottom: 12 }}>Pending ({pending.length})</div>

        {!reachable && (
          <div className="glass" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--fg-3)', fontSize: '.875rem' }}>
            No pending approvals — SparkGatekeeper is unreachable.
          </div>
        )}

        {reachable && pending.length === 0 && (
          <div className="glass reveal" style={{ padding: '2.5rem', textAlign: 'center', display: 'flex',
            flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--ok)' }}><Icon name="check" size={28} /></span>
            <div style={{ fontWeight: 600 }}>Queue is clear</div>
            <div className="sub">Nothing is waiting on your approval.</div>
          </div>
        )}

        {pending.map((item, i) => {
          const busy = acting.has(item.id)
          const c = item.risk_level ? RISK[item.risk_level] : 'var(--fg-3)'
          return (
            <div key={item.id} className={`glass glass-hover reveal reveal-${Math.min(i + 1, 6)}`}
              style={{ padding: '1.1rem 1.25rem', marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  {item.risk_level && (
                    <span className="pill" style={{ color: c, borderColor: c + '55', background: c + '18' }}>
                      {item.risk_level}
                    </span>
                  )}
                  <span style={{ fontWeight: 650, fontSize: '.95rem' }}>{item.action}</span>
                </div>
                <span className="sub" style={{ whiteSpace: 'nowrap' }}>{ago(item.created_at)}</span>
              </div>

              <div className="sub" style={{ marginBottom: 8 }}>
                agent <span className="mono" style={{ color: 'var(--fg-2)' }}>{item.agent}…</span>
                {item.expires_at && <> · {expiresIn(item.expires_at)}</>}
              </div>

              <div className="mono" style={{ fontSize: '.78rem', color: 'var(--fg-2)', background: 'rgba(0,0,0,.28)',
                borderRadius: 8, padding: '.5rem .7rem', marginBottom: 12, borderLeft: '3px solid var(--brand-2)',
                wordBreak: 'break-word' }}>
                {item.customer_context}
              </div>

              <div style={{ display: 'flex', gap: '.6rem' }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => approve(item.id)}
                  style={{ flex: 1, justifyContent: 'center' }}>
                  {busy ? '…' : 'Approve'}
                </button>
                <button className="btn" disabled={busy} onClick={() => deny(item.id)}
                  style={{ flex: 1, justifyContent: 'center', color: 'var(--bad)', borderColor: 'var(--bad)' }}>
                  {busy ? '…' : 'Deny'}
                </button>
              </div>
            </div>
          )
        })}
      </section>

      {audit.length > 0 && (
        <section>
          <div className="h2" style={{ marginBottom: 12 }}>Recent Decisions ({audit.length})</div>
          <div className="glass" style={{ overflow: 'hidden' }}>
            {audit.map((e, i) => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '.75rem', padding: '.65rem 1rem',
                borderBottom: i < audit.length - 1 ? '1px solid var(--line)' : 'none' }}>
                <span style={{ fontSize: '.72rem', fontWeight: 700, width: 52, flexShrink: 0,
                  color: e.decision === 'approved' ? 'var(--ok)' : 'var(--bad)' }}>
                  {e.decision === 'approved' ? '✓ APPR' : '✗ DENY'}
                </span>
                <span style={{ flex: 1, fontSize: '.82rem' }}>{e.action}</span>
                <span className="sub">{ago(e.decided_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
