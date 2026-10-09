import { useState, useEffect } from 'react'

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
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0f1117',
    }}>
      <form onSubmit={submit} style={{
        background: '#1a1f2e', border: '1px solid #2d3748', borderRadius: 12,
        padding: '2.5rem 3rem', display: 'flex', flexDirection: 'column', gap: '1.2rem',
        minWidth: 320,
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '0.3rem' }}>🔐</div>
          <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '1.1rem' }}>HelixMain</div>
          <div style={{ color: '#718096', fontSize: '0.82rem' }}>Owner Dashboard</div>
        </div>
        <input
          autoFocus
          type="password"
          placeholder="Enter PIN"
          value={pin}
          onChange={(e) => { setPin(e.target.value); setError('') }}
          style={{
            background: '#0f1117', border: '1px solid #2d3748', color: '#e2e8f0',
            borderRadius: 8, padding: '0.65rem 1rem', fontSize: '1rem', outline: 'none',
          }}
        />
        {error && <div style={{ color: '#fc8181', fontSize: '0.82rem', textAlign: 'center' }}>{error}</div>}
        <button type="submit" style={{
          background: '#4299e1', color: '#fff', border: 'none', borderRadius: 8,
          padding: '0.65rem', fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer',
        }}>
          Unlock
        </button>
      </form>
    </div>
  )
}
