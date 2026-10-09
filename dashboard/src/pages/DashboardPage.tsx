import { useEffect, useState } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'
import { CompanyCard } from '../components/CompanyCard'
import type { HealthResult } from '../api'

interface AnalyticsSummary {
  callVolume: number
  leadsTotal?: number
  leadsConverted?: number
  campaignsSent?: number
}

interface AdminHealth {
  api: { status: string; uptime: number }
  stores: { leads: number; assets: number; prds: number; accounts: number }
  cache: { neural: number }
}

interface MeteringAccount {
  balance: number
  tier: 'free' | 'pro' | 'agency'
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

const TIER_COLORS: Record<string, string> = {
  free:   '#64748b',
  pro:    '#6366f1',
  agency: '#f59e0b',
}

export function DashboardPage() {
  const { companies, buildStatus, setCompanies, setBuildStatus, currentCompany } = useHelixStore()
  const [healthMap, setHealthMap]     = useState<Record<string, HealthResult>>({})
  const [analytics, setAnalytics]     = useState<AnalyticsSummary | null>(null)
  const [adminHealth, setAdminHealth] = useState<AdminHealth | null>(null)
  const [metering, setMetering]       = useState<MeteringAccount | null>(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)

  useEffect(() => {
    let live = true
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [list, bs] = await Promise.all([api.listCompanies(), api.buildStatus()])
        if (!live) return
        setCompanies(list)
        setBuildStatus(bs)

        // Fetch health for each company in parallel (best-effort)
        const results = await Promise.allSettled(list.map((c) => api.health(c.id)))
        const map: Record<string, HealthResult> = {}
        list.forEach((c, i) => {
          const r = results[i]
          if (r.status === 'fulfilled') map[c.id] = r.value
        })
        if (live) setHealthMap(map)

        // Admin health (best-effort)
        try {
          const ah = await fetch('/api/admin/health').then((r) => r.json()) as AdminHealth
          if (live) setAdminHealth(ah)
        } catch { /* non-fatal */ }

      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (live) setLoading(false)
      }
    }
    load()
    return () => { live = false }
  }, [setCompanies, setBuildStatus])

  // When currentCompany changes, fetch per-company data
  useEffect(() => {
    if (!currentCompany) return
    let live = true

    async function loadCompanyData() {
      if (!currentCompany) return
      try {
        const [analyticsRes, meteringRes] = await Promise.allSettled([
          fetch(`/api/analytics/${currentCompany.id}/enriched`).then((r) => r.json()) as Promise<AnalyticsSummary>,
          fetch(`/api/metering/${currentCompany.id}`).then((r) => r.json()) as Promise<MeteringAccount>,
        ])
        if (!live) return
        if (analyticsRes.status === 'fulfilled') setAnalytics(analyticsRes.value)
        if (meteringRes.status === 'fulfilled')  setMetering(meteringRes.value)
      } catch { /* non-fatal */ }
    }

    loadCompanyData()
    return () => { live = false }
  }, [currentCompany])

  const buildOk = !buildStatus || buildStatus.status === 'ok'

  if (loading) {
    return (
      <div style={{ color: '#94a3b8', padding: '2rem', textAlign: 'center' }}>
        Loading companies…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ color: '#ef4444', padding: '2rem' }}>
        <strong>Failed to load:</strong> {error}
      </div>
    )
  }

  const metricCardStyle: React.CSSProperties = {
    background: '#1e2433', borderRadius: 10, padding: '1rem 1.25rem',
    border: '1px solid #2d3748', display: 'flex', flexDirection: 'column', gap: '0.25rem',
  }
  const metricLabelStyle: React.CSSProperties = {
    fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const metricValueStyle: React.CSSProperties = {
    fontSize: '1.5rem', fontWeight: 700, color: '#f1f5f9', lineHeight: 1.2,
  }

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>
          My Companies
        </h1>
        <p style={{ color: '#64748b', fontSize: '0.875rem', marginTop: '0.35rem' }}>
          {companies.length} business{companies.length !== 1 ? 'es' : ''} onboarded
        </p>
      </div>

      {/* Metrics grid */}
      {(analytics || adminHealth || metering) && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1.75rem',
        }}>
          {/* Credits Remaining */}
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Credits Remaining</span>
            <span style={metricValueStyle}>
              {metering ? metering.balance.toLocaleString() : '—'}
            </span>
            {metering && (
              <span style={{
                fontSize: '0.7rem', fontWeight: 600, padding: '0.15rem 0.5rem',
                background: TIER_COLORS[metering.tier] + '22',
                color: TIER_COLORS[metering.tier],
                borderRadius: 4, alignSelf: 'flex-start', marginTop: '0.2rem',
              }}>
                {metering.tier.toUpperCase()}
              </span>
            )}
          </div>

          {/* Leads */}
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Leads</span>
            <span style={metricValueStyle}>
              {analytics?.leadsTotal ?? '—'}
            </span>
            {analytics && typeof analytics.leadsConverted === 'number' && (
              <span style={{ fontSize: '0.75rem', color: '#22c55e' }}>
                {analytics.leadsConverted} converted
              </span>
            )}
          </div>

          {/* Campaigns */}
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>Campaigns Sent</span>
            <span style={metricValueStyle}>
              {analytics?.campaignsSent ?? '—'}
            </span>
          </div>

          {/* API Uptime */}
          <div style={metricCardStyle}>
            <span style={metricLabelStyle}>API Uptime</span>
            <span style={metricValueStyle}>
              {adminHealth ? formatUptime(adminHealth.api.uptime) : '—'}
            </span>
            {adminHealth && (
              <span style={{
                fontSize: '0.7rem', color: adminHealth.api.status === 'ok' ? '#22c55e' : '#ef4444',
              }}>
                {adminHealth.api.status}
              </span>
            )}
          </div>
        </div>
      )}

      {companies.length === 0 ? (
        <div style={{
          background: '#1e2433', borderRadius: 12, padding: '3rem',
          textAlign: 'center', border: '2px dashed #2d3748',
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>🏢</div>
          <div style={{ fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
            No companies yet
          </div>
          <div style={{ color: '#64748b', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
            Onboard your first business to get started.
          </div>
          <a href="/onboard" style={{
            background: '#6366f1', color: '#fff', borderRadius: 8,
            padding: '0.55rem 1.25rem', textDecoration: 'none', fontSize: '0.875rem', fontWeight: 600,
          }}>
            Onboard a Business
          </a>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: '1rem',
        }}>
          {companies.map((c) => (
            <CompanyCard
              key={c.id}
              company={c}
              health={healthMap[c.id] ?? null}
              buildOk={buildOk}
            />
          ))}
        </div>
      )}
    </div>
  )
}
