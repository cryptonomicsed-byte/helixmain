import { useNavigate } from 'react-router-dom'
import { useHelixStore } from '../store'
import { HealthBadge } from './HealthBadge'
import { Icon } from './Icon'
import type { Company, HealthResult } from '../api'

interface Props {
  company: Company
  health: HealthResult | null
  buildOk: boolean
}

function ago(ts: string): string {
  if (!ts) return 'never synced'
  const t = new Date(ts).getTime()
  if (Number.isNaN(t)) return 'never synced'
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 0) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function CompanyCard({ company, health, buildOk }: Props) {
  const navigate = useNavigate()
  const setCurrentCompany = useHelixStore((s) => s.setCurrentCompany)

  function go(path: string) {
    setCurrentCompany(company)
    navigate(path)
  }

  return (
    <div className="glass glass-hover" style={{ padding: 'var(--pad)', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ display: 'flex', gap: '.7rem', minWidth: 0 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center',
            background: 'linear-gradient(140deg, rgba(129,140,248,.22), rgba(167,139,250,.10))',
            border: '1px solid var(--line-2)', color: 'var(--brand)',
          }}>
            <Icon name="company" size={18} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h3 className="h2" style={{ margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {company.name?.trim() || 'Untitled company'}
            </h3>
            <div className="sub" style={{ marginTop: 2 }}>
              v{company.cardVersion} · {ago(company.lastUpdated)}
              {!company.name?.trim() && <> · <span className="mono">{company.id}</span></>}
            </div>
          </div>
        </div>
        <span title={buildOk ? 'Build OK' : 'Build failed'}
          className={`dot ${buildOk ? '' : 'dot-bad'}`}
          style={{ color: buildOk ? 'var(--ok)' : 'var(--bad)', marginTop: 6 }} />
      </div>

      <HealthBadge health={health} compact />

      {/* Actions */}
      <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginTop: 'auto' }}>
        <button className="btn btn-primary" onClick={() => go(`/company/${company.id}`)} style={{ fontSize: '.78rem', padding: '.4rem .7rem' }}>
          Edit Card
        </button>
        <button className="btn" onClick={() => go(`/company/${company.id}?tab=greeting`)} style={{ fontSize: '.78rem', padding: '.4rem .7rem' }}>
          Test Agent
        </button>
        <a className="btn btn-ghost" href={`https://helixmain.duckdns.org/${company.id}`} target="_blank" rel="noreferrer"
           style={{ fontSize: '.78rem', padding: '.4rem .7rem', textDecoration: 'none' }}>
          Public <Icon name="arrow" size={13} />
        </a>
      </div>
    </div>
  )
}
