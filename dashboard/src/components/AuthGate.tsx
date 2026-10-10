import { useState } from 'react'
import { Icon } from './Icon'
import { getApiKey, setApiKey, setOwnerKey } from '../api'

const SESSION_KEY = 'helix_auth'
const SESSION_MARK = 'ok'

/**
 * The PIN must come from the build environment. It is deliberately NOT given a
 * hardcoded fallback: a fallback committed to git is not auth, it is a
 * documented key. If VITE_DASHBOARD_PIN is unset the dashboard refuses to
 * unlock rather than silently accepting a known value.
 *
 * The PIN is only the UI gate. It is a speed bump, not the security boundary —
 * anything in a Vite bundle is readable. The API is what actually enforces
 * access, via the key entered below and kept in localStorage (never bundled).
 */
const CONFIGURED_PIN = (import.meta.env.VITE_DASHBOARD_PIN as string | undefined)?.trim() ?? ''
const MISCONFIGURED = CONFIGURED_PIN.length === 0

function checkSession(): boolean {
  return sessionStorage.getItem(SESSION_KEY) === SESSION_MARK && getApiKey().length > 0
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(checkSession)
  const [pin, setPin] = useState('')
  const [key, setKey] = useState('')
  const [owner, setOwner] = useState('')
  const [error, setError] = useState('')

  if (authed) return <>{children}</>

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (MISCONFIGURED) return
    if (pin !== CONFIGURED_PIN) {
      setError('Incorrect PIN')
      setPin('')
      return
    }
    if (!key.trim()) {
      setError('API key required')
      return
    }
    setApiKey(key.trim())
    if (owner.trim()) setOwnerKey(owner.trim())
    sessionStorage.setItem(SESSION_KEY, SESSION_MARK)
    setAuthed(true)
    setError('')
  }

  const field = (bad: boolean): React.CSSProperties => ({
    background: 'rgba(0,0,0,.28)',
    border: `1px solid ${bad ? 'rgba(248,113,113,.6)' : 'var(--line-2)'}`,
    color: 'var(--fg)',
    borderRadius: 11,
    padding: '.7rem 1rem',
    fontSize: '.9rem',
    outline: 'none',
    width: '100%',
    transition: 'border-color 160ms',
  })

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', position: 'relative' }}>
      <div className="aurora" />
      <form onSubmit={submit} className="glass reveal"
        style={{ position: 'relative', zIndex: 1, padding: '2.5rem 2.75rem', display: 'flex', flexDirection: 'column',
                 gap: '1.15rem', width: 400, boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.55rem' }}>
          <div style={{ width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center',
                        background: 'linear-gradient(140deg, var(--brand), var(--violet))', boxShadow: 'var(--glow)', color: 'var(--bg)' }}>
            <Icon name="bolt" size={24} />
          </div>
          <div style={{ fontWeight: 750, fontSize: '1.15rem', letterSpacing: '-.02em' }}>
            Helix<span className="grad-text">Main</span>
          </div>
          <div className="sub" style={{ fontSize: '.8rem' }}>
            {MISCONFIGURED ? 'Dashboard not configured' : 'Owner Dashboard — unlock to continue'}
          </div>
        </div>

        {MISCONFIGURED ? (
          <div style={{
            background: 'rgba(248,113,113,.10)', border: '1px solid rgba(248,113,113,.35)',
            borderRadius: 11, padding: '.85rem 1rem', fontSize: '.82rem', color: 'var(--fg-2)', lineHeight: 1.5,
          }}>
            <strong style={{ color: 'var(--bad)' }}>VITE_DASHBOARD_PIN is not set.</strong><br />
            This build has no PIN, so unlocking is disabled by design — a committed
            fallback would be a known key. Rebuild with the env var set:
            <div className="mono" style={{ marginTop: '.5rem', fontSize: '.74rem', color: 'var(--fg-3)' }}>
              VITE_DASHBOARD_PIN=… npm run build
            </div>
          </div>
        ) : (
          <>
            <input
              autoFocus
              type="password"
              placeholder="PIN"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError('') }}
              style={{ ...field(!!error), textAlign: 'center', letterSpacing: '.2em' }}
            />
            <input
              type="password"
              placeholder="API key (hk_…)"
              value={key}
              onChange={(e) => { setKey(e.target.value); setError('') }}
              style={{ ...field(!!error), fontFamily: 'var(--mono, monospace)', fontSize: '.82rem' }}
            />
            <input
              type="password"
              placeholder="Owner key (hk_…) — optional, needed to edit the card"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              style={{ ...field(false), fontFamily: 'var(--mono, monospace)', fontSize: '.82rem' }}
            />
            {error && <div style={{ color: 'var(--bad)', fontSize: '.8rem', textAlign: 'center', marginTop: -6 }}>{error}</div>}
            <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '.65rem', fontSize: '.9rem' }}>
              Unlock <Icon name="arrow" size={15} />
            </button>
            <div className="sub" style={{ fontSize: '.72rem', textAlign: 'center', lineHeight: 1.5 }}>
              Keys live at <span className="mono">/etc/helix/companies/&lt;id&gt;/api-keys.json</span> on the server.
              They are kept in this browser only — never in the build.
            </div>
          </>
        )}
      </form>
    </div>
  )
}
