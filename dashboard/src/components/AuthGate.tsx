import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { auth, sessionInfo, setApiKey, setOwnerKey } from '../api'

/*
 * One credential. The owner unlocks with a passkey — no PIN, no pasted API key.
 * A successful ceremony sets an HttpOnly session cookie; the API maps that to the
 * company, so the per-company key never touches the browser.
 *
 * Enrollment is bootstrapped by a one-time link (infra/issue-enroll-token.py):
 *   https://helixmain.duckdns.org/dashboard/?enroll=<token>
 *
 * A discreet "use a key" path is kept as break-glass so a WebAuthn hiccup on some
 * device can never lock the owner out of their own dashboard.
 */

/* ── WebAuthn helpers (same shape the Gatekeeper's ApprovalsPage uses) ────── */
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
function strToBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer
}

async function createPasskey(options: any): Promise<unknown> {
  const pk = options.publicKey ?? options
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: b64urlToBuf(pk.challenge),
    rp: pk.rp,
    user: { ...pk.user, id: strToBuf(pk.user.id) },
    pubKeyCredParams: pk.pubKeyCredParams,
    timeout: pk.timeout,
    attestation: pk.attestation ?? 'none',
    excludeCredentials: (pk.excludeCredentials ?? []).map((c: any) => ({ ...c, id: b64urlToBuf(c.id) })),
    authenticatorSelection: pk.authenticatorSelection
      ?? { userVerification: 'required', residentKey: 'required' },
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

async function assertPasskey(options: any): Promise<unknown> {
  const pk = options.publicKey ?? options
  const allow = (pk.allowCredentials ?? []).map((c: any) => ({
    type: c.type ?? 'public-key', id: b64urlToBuf(c.id), transports: c.transports,
  }))
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: b64urlToBuf(pk.challenge),
    rpId: pk.rpId,
    allowCredentials: allow,
    userVerification: pk.userVerification ?? 'required',
    ...(pk.timeout ? { timeout: pk.timeout } : {}),
  }}) as PublicKeyCredential
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

function passkeysSupported(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && typeof (window as any).PublicKeyCredential !== 'undefined'
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'locked' | 'open'>('checking')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showKeyFallback, setShowKeyFallback] = useState(false)
  const [key, setKey] = useState('')
  const [owner, setOwner] = useState('')

  const enrollToken = new URLSearchParams(window.location.search).get('enroll') ?? ''

  useEffect(() => {
    sessionInfo().then((s) => setState(s?.ok ? 'open' : 'locked'))
  }, [])

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn() } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const unlock = () => run(async () => {
    if (!passkeysSupported()) {
      throw new Error('This browser can’t use passkeys here — needs https and a modern browser.')
    }
    const { options } = await auth.loginOptions()
    const assertion = await assertPasskey(options)
    await auth.loginVerify(assertion)
    setState('open')
  })

  const enroll = () => run(async () => {
    if (!passkeysSupported()) {
      throw new Error('This browser can’t create a passkey here — needs https and a modern browser.')
    }
    const { options } = await auth.registerOptions(enrollToken)
    const attestation = await createPasskey(options)
    await auth.registerVerify(enrollToken, attestation)
    window.history.replaceState(null, '', window.location.pathname)
    setState('open')
  })

  const unlockWithKey = () => run(async () => {
    if (!key.trim()) throw new Error('API key required')
    setApiKey(key.trim())
    if (owner.trim()) setOwnerKey(owner.trim())
    const s = await sessionInfo()
    if (!s?.ok) throw new Error('key rejected')
    setState('open')
  })

  if (state === 'checking') {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--fg-3)' }}>…</div>
  }
  if (state === 'open') return <>{children}</>

  const field: React.CSSProperties = {
    background: 'rgba(0,0,0,.28)', border: '1px solid var(--line-2)', color: 'var(--fg)',
    borderRadius: 11, padding: '.7rem 1rem', fontSize: '.9rem', outline: 'none', width: '100%',
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', position: 'relative' }}>
      <div className="aurora" />
      <div className="glass reveal" style={{ position: 'relative', zIndex: 1, padding: '2.5rem 2.75rem',
        display: 'flex', flexDirection: 'column', gap: '1.15rem', width: 400, boxShadow: 'var(--shadow-lg)' }}>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.55rem' }}>
          <div style={{ width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center',
            background: 'linear-gradient(140deg, var(--brand), var(--violet))', boxShadow: 'var(--glow)', color: 'var(--bg)' }}>
            <Icon name="bolt" size={24} />
          </div>
          <div style={{ fontWeight: 750, fontSize: '1.15rem', letterSpacing: '-.02em' }}>
            Helix<span className="grad-text">Main</span>
          </div>
          <div className="sub" style={{ fontSize: '.8rem' }}>
            {enrollToken ? 'Set up this device' : 'Owner Dashboard'}
          </div>
        </div>

        {error && (
          <div style={{ background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.35)',
            borderRadius: 11, padding: '.7rem .9rem', fontSize: '.8rem', color: 'var(--fg-2)' }}>{error}</div>
        )}

        {enrollToken ? (
          <>
            <div className="sub" style={{ fontSize: '.78rem', textAlign: 'center', lineHeight: 1.5 }}>
              Enrolling a passkey for your dashboard. You’ll be asked for your fingerprint,
              face, or device PIN — that becomes your only login.
            </div>
            <button className="btn btn-primary" disabled={busy} onClick={enroll}
              style={{ justifyContent: 'center', padding: '.7rem', fontSize: '.92rem' }}>
              {busy ? 'Waiting…' : 'Create passkey'} <Icon name="bolt" size={15} />
            </button>
          </>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={unlock}
            style={{ justifyContent: 'center', padding: '.7rem', fontSize: '.92rem' }}>
            {busy ? 'Waiting…' : 'Unlock with passkey'} <Icon name="arrow" size={15} />
          </button>
        )}

        {!passkeysSupported() && (
          <div className="sub" style={{ fontSize: '.72rem', textAlign: 'center', lineHeight: 1.5 }}>
            Passkeys need https and a modern browser. Open this page over
            <span className="mono"> https://helixmain.duckdns.org/dashboard/</span>.
          </div>
        )}

        {/* Break-glass. Not the path anyone should need, but never a lockout. */}
        {!enrollToken && (
          showKeyFallback ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', borderTop: '1px solid var(--line-2)', paddingTop: '.9rem' }}>
              <input type="password" placeholder="API key (hk_…)" value={key}
                onChange={(e) => { setKey(e.target.value); setError('') }} style={field} />
              <input type="password" placeholder="Owner key — only to edit the card" value={owner}
                onChange={(e) => setOwner(e.target.value)}
                style={{ ...field, fontFamily: 'var(--mono, monospace)', fontSize: '.82rem' }} />
              <button className="btn" disabled={busy} onClick={unlockWithKey}
                style={{ justifyContent: 'center', padding: '.55rem', fontSize: '.85rem' }}>Unlock with key</button>
            </div>
          ) : (
            <button onClick={() => setShowKeyFallback(true)}
              style={{ background: 'none', border: 'none', color: 'var(--fg-3)', fontSize: '.72rem', cursor: 'pointer' }}>
              Can’t use a passkey? Use an API key instead
            </button>
          )
        )}

        <div className="sub" style={{ fontSize: '.7rem', textAlign: 'center', lineHeight: 1.5 }}>
          No passkey on this device yet? Ask the operator for a one-time enrollment link.
        </div>
      </div>
    </div>
  )
}
