import { useEffect, useState } from 'react'
import { api } from '../api'
import { useHelixStore } from '../store'
import type { GreetingResult, Voice } from '../api'

export function GreetingPage() {
  const currentCompany = useHelixStore((s) => s.currentCompany)
  const currentCard    = useHelixStore((s) => s.currentCard)

  const [greeting, setGreeting] = useState<GreetingResult | null>(null)
  const [voices, setVoices]     = useState<Voice[]>([])
  const [selectedVoice, setSelectedVoice] = useState<string>('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    api.voices().then(setVoices).catch(() => {})
  }, [])

  async function load() {
    if (!currentCard || !currentCompany) return
    setLoading(true)
    setError(null)
    try {
      const g = await api.greeting(currentCard.id, currentCompany.id)
      setGreeting(g)
      if (g.voice && !selectedVoice) setSelectedVoice(g.voice)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  if (!currentCompany) {
    return (
      <div style={{ color: '#64748b', padding: '2rem' }}>
        Select a company from the top bar to preview greetings.
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>
          Greeting Preview
        </h1>
        <p style={{ color: '#64748b', fontSize: '0.875rem', marginTop: '0.35rem' }}>
          {currentCompany.name}
        </p>
      </div>

      {/* Voice picker */}
      {voices.length > 0 && (
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: '0.3rem' }}>
            Voice
          </label>
          <select
            value={selectedVoice}
            onChange={(e) => setSelectedVoice(e.target.value)}
            style={{
              background: '#0f1117', border: '1px solid #2d3748', color: '#e2e8f0',
              borderRadius: 6, padding: '0.45rem 0.7rem', fontSize: '0.85rem',
              width: '100%', outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="">— default voice —</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.provider}{v.gender ? ' · ' + v.gender : ''})
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        onClick={load}
        disabled={loading || !currentCard}
        style={{
          background: loading ? '#374151' : '#6366f1', color: '#fff',
          border: 'none', borderRadius: 8, padding: '0.6rem 1.5rem',
          fontSize: '0.9rem', fontWeight: 700,
          cursor: loading || !currentCard ? 'not-allowed' : 'pointer',
          marginBottom: '1.5rem', width: '100%',
        }}
      >
        {loading ? '⏳ Compiling greetings…' : 'Compile & Preview Greetings'}
      </button>

      {!currentCard && (
        <div style={{ color: '#f59e0b', fontSize: '0.82rem', marginBottom: '1rem' }}>
          No card loaded for this company. Go to the Company page first.
        </div>
      )}

      {error && (
        <div style={{ color: '#ef4444', fontSize: '0.82rem', padding: '0.6rem', background: '#ef444411', borderRadius: 6, marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {greeting && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {(['morning', 'afternoon', 'evening', 'default'] as const).map((period) => {
            const text = greeting[period]
            if (!text) return null
            const icons: Record<string, string> = { morning: '🌅', afternoon: '☀️', evening: '🌙', default: '👋' }
            return (
              <div key={period} style={{
                background: '#1e2433', borderRadius: 10, padding: '1.1rem 1.25rem',
                border: '1px solid #2d3748',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
                  <span>{icons[period]}</span>
                  <span style={{ fontSize: '0.72rem', color: '#6366f1', fontWeight: 700, textTransform: 'uppercase' }}>
                    {period}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '0.92rem', color: '#e2e8f0', lineHeight: 1.6 }}>{text}</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
