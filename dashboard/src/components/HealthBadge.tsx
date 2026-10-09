import type { HealthResult } from '../api'

interface Props {
  health: HealthResult | null
  compact?: boolean
}

function scoreColor(score: number): string {
  if (score >= 80) return 'var(--ok)'
  if (score >= 50) return 'var(--warn)'
  return 'var(--bad)'
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Healthy'
  if (score >= 50) return 'Needs Work'
  return 'Incomplete'
}

export function HealthBadge({ health, compact = false }: Props) {
  if (!health) {
    return (
      <span style={{ color: 'var(--fg-3)', fontSize: '0.75rem' }}>No health data</span>
    )
  }

  const color = scoreColor(health.score)

  if (compact) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
        alignSelf: 'flex-start', width: 'fit-content',
        background: color + '22', color, borderRadius: '999px',
        padding: '0.15rem 0.6rem', fontSize: '0.72rem', fontWeight: 600,
        border: `1px solid ${color}44`,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block' }} />
        {health.score}% {scoreLabel(health.score)}
      </span>
    )
  }

  return (
    <div className="glass" style={{ background: 'var(--surface)', borderRadius: 10, padding: '1.25rem', border: '1px solid var(--line-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          border: `3px solid ${color}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1.1rem', fontWeight: 700, color,
        }}>
          {health.score}
        </div>
        <div>
          <div style={{ fontWeight: 700, color, fontSize: '1rem' }}>{scoreLabel(health.score)}</div>
          <div style={{ color: 'var(--fg-2)', fontSize: '0.8rem' }}>Card completeness score</div>
        </div>
      </div>

      {/* Check grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', marginBottom: '0.75rem' }}>
        {Object.entries(health.checks).map(([key, pass]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: 'var(--fg)' }}>
            <span style={{ color: pass ? 'var(--ok)' : 'var(--bad)' }}>{pass ? '✓' : '✗'}</span>
            {key.replace(/_/g, ' ')}
          </div>
        ))}
      </div>

      {health.suggestions.length > 0 && (
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--fg-2)', marginBottom: '0.4rem', fontWeight: 600 }}>SUGGESTIONS</div>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {health.suggestions.map((s, i) => (
              <li key={i} style={{
                fontSize: '0.8rem', color: 'var(--fg)',
                padding: '0.35rem 0.5rem', marginBottom: '0.25rem',
                background: '#f59e0b11', borderLeft: '3px solid var(--warn)',
                borderRadius: '0 4px 4px 0',
              }}>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
