import { useNavigate } from 'react-router-dom'
import { useHelixStore } from '../store'
import { HealthBadge } from './HealthBadge'
import type { Company, HealthResult } from '../api'

interface Props {
  company: Company
  health: HealthResult | null
  buildOk: boolean
}

function ago(ts: string): string {
  try {
    const diff = Date.now() - new Date(ts).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  } catch {
    return ts
  }
}

export function CompanyCard({ company, health, buildOk }: Props) {
  const navigate = useNavigate()
  const setCurrentCompany = useHelixStore((s) => s.setCurrentCompany)

  function go(path: string) {
    setCurrentCompany(company)
    navigate(path)
  }

  return (
    <div style={{
      background: '#1e2433', borderRadius: 12, padding: '1.25rem',
      border: '1px solid #2d3748', display: 'flex', flexDirection: 'column', gap: '0.85rem',
      transition: 'border-color 0.15s',
    }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#6366f1')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#2d3748')}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f1f5f9' }}>
            {company.name}
          </h3>
          <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.2rem' }}>
            v{company.cardVersion} · updated {ago(company.lastUpdated)}
          </div>
        </div>
        {/* Build status dot */}
        <span title={buildOk ? 'Build OK' : 'Build failed'} style={{
          width: 10, height: 10, borderRadius: '50%',
          background: buildOk ? '#22c55e' : '#ef4444',
          display: 'inline-block', marginTop: 4,
        }} />
      </div>

      {/* Health badge compact */}
      <HealthBadge health={health} compact />

      {/* Quick actions */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          onClick={() => go(`/company/${company.id}`)}
          style={btnStyle('#6366f1', '#818cf8')}
        >
          Edit Card
        </button>
        <button
          onClick={() => go(`/company/${company.id}?tab=greeting`)}
          style={btnStyle('#0f1117', '#94a3b8', true)}
        >
          Test Agent
        </button>
        <a
          href={`https://helixmain.duckdns.org/${company.id}`}
          target="_blank" rel="noreferrer"
          style={{ ...btnStyle('#0f1117', '#94a3b8', true), textDecoration: 'none' } as React.CSSProperties}
        >
          Public Page ↗
        </a>
      </div>
    </div>
  )
}

function btnStyle(bg: string, color: string, outlined = false): React.CSSProperties {
  return {
    background: bg, color, border: outlined ? `1px solid ${color}` : 'none',
    borderRadius: 6, padding: '0.3rem 0.7rem', fontSize: '0.78rem',
    cursor: 'pointer', fontWeight: 600,
  }
}
