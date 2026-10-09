import { useState, useEffect } from 'react'
import { Icon } from './Icon'

const SESSION_KEY = 'helix_auth'
// Set VITE_DASHBOARD_PIN at build time; falls back to a safe default
const CORRECT_PIN = import.meta.env.VITE_DASHBOARD_PIN ?? 'helix2024'

function checkSession(): boolean {
  return sessionStorage.getItem(SESSION_KEY) === CORRECT_PIN
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(checkSession)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (authed) sessionStorage.setItem(SESSION_KEY, CORRECT_PIN)
  }, [authed])

  if (authed) return <>{children}</>

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (pin === CORRECT_PIN) {
      setAuthed(true)
      setError('')
    } else {
      setError('Incorrect PIN')
      setPin('')
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', position: 'relative' }}>
      <div className="aurora" />
      <form onSubmit={submit} className="glass reveal"
        style={{ position: 'relative', zIndex: 1, padding: '2.5rem 2.75rem', display: 'flex', flexDirection: 'column',
                 gap: '1.15rem', width: 360, boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.55rem' }}>
          <div style={{ width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center',
                        background: 'linear-gradient(140deg, var(--brand), var(--violet))', boxShadow: 'var(--glow)', color: 'var(--bg)' }}>
            <Icon name="bolt" size={24} />
          </div>
          <div style={{ fontWeight: 750, fontSize: '1.15rem', letterSpacing: '-.02em' }}>
            Helix<span className="grad-text">Main</span>
          </div>
          <div className="sub" style={{ fontSize: '.8rem' }}>Owner Dashboard — enter PIN to unlock</div>
        </div>

        <input
          autoFocus
          type="password"
          placeholder="••••••••"
          value={pin}
          onChange={(e) => { setPin(e.target.value); setError('') }}
          style={{
            background: 'rgba(0,0,0,.28)', border: `1px solid ${error ? 'rgba(248,113,113,.6)' : 'var(--line-2)'}`,
            color: 'var(--fg)', borderRadius: 11, padding: '.7rem 1rem', fontSize: '1rem',
            outline: 'none', textAlign: 'center', letterSpacing: '.2em', transition: 'border-color 160ms',
          }}
        />
        {error && <div style={{ color: 'var(--bad)', fontSize: '.8rem', textAlign: 'center', marginTop: -6 }}>{error}</div>}
        <button type="submit" className="btn btn-primary" style={{ justifyContent: 'center', padding: '.65rem', fontSize: '.9rem' }}>
          Unlock <Icon name="arrow" size={15} />
        </button>
      </form>
    </div>
  )
}
