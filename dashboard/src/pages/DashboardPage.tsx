import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useHelixStore } from '../store'
import { authFetch, api } from '../api'
import { CompanyCard } from '../components/CompanyCard'
import { Icon } from '../components/Icon'
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

const TIER_COLOR: Record<string, string> = { free: 'var(--fg-3)', pro: 'var(--brand)', agency: 'var(--warn)' }

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return `${h}h ${m}m`
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function StatCard({ label, value, sub, tone, icon, delay }: {
  label: string; value: string; sub?: React.ReactNode; tone?: string; icon: string; delay: string
}) {
  return (
    <div className={`glass glass-hover reveal ${delay}`} style={{ gridColumn: 'span 3', padding: 'var(--pad)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600 }}>{label}</span>
        <span style={{ color: tone ?? 'var(--brand)', opacity: .85 }}><Icon name={icon} size={16} /></span>
      </div>
      <div className="stat-val" style={{ color: value === '—' ? 'var(--fg-3)' : tone }}>{value}</div>
      {sub && <div style={{ marginTop: -2 }}>{sub}</div>}
    </div>
  )
}

export function DashboardPage() {
  const { companies, buildStatus, setCompanies, setBuildStatus, currentCompany } = useHelixStore()
  const [healthMap, setHealthMap] = useState<Record<string, HealthResult>>({})
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null)
  const [adminHealth, setAdminHealth] = useState<AdminHealth | null>(null)
  const [credits, setCredits]         = useState<number | null>(null)
  const [tier, setTier]               = useState<string | null>(null)
  const [scope, setScope]             = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    async function load() {
      setLoading(true); setError(null)
      try {
        const [list, bs] = await Promise.all([api.listCompanies(), api.buildStatus()])
        if (!live) return
        setCompanies(list); setBuildStatus(bs)
        const results = await Promise.allSettled(list.map((c) => api.health(c.id)))
        const map: Record<string, HealthResult> = {}
        list.forEach((c, i) => { const r = results[i]; if (r.status === 'fulfilled') map[c.id] = r.value })
        if (live) setHealthMap(map)
        try {
          const ah = await authFetch('/admin/health').then((r) => r.json()) as AdminHealth
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

  useEffect(() => {
    if (companies.length === 0) return
    let live = true
    async function loadMetrics() {
      try {
        if (currentCompany) {
          const [a, m] = await Promise.allSettled([
            authFetch(`/analytics/${currentCompany.id}/enriched`).then((r) => r.json()) as Promise<AnalyticsSummary>,
            authFetch(`/metering/${currentCompany.id}`).then((r) => r.json()) as Promise<MeteringAccount>,
          ])
          if (!live) return
          if (a.status === 'fulfilled') setAnalytics(a.value)
          if (m.status === 'fulfilled') { setCredits(m.value.balance); setTier(m.value.tier) }
          setScope(currentCompany.name)
        } else {
          // No company selected → workspace totals. These are real sums over the
          // per-company endpoints, never fabricated; a company that fails to
          // respond simply contributes nothing.
          const pairs = await Promise.allSettled(
            companies.flatMap((c) => [
              authFetch(`/analytics/${c.id}/enriched`).then((r) => r.json()) as Promise<AnalyticsSummary>,
              authFetch(`/metering/${c.id}`).then((r) => r.json()) as Promise<MeteringAccount>,
            ]),
          )
          if (!live) return
          let leads = 0, conv = 0, campaigns = 0, calls = 0, cr = 0, any = false
          pairs.forEach((res, i) => {
            if (res.status !== 'fulfilled') return
            any = true
            if (i % 2 === 0) {
              const a = res.value as AnalyticsSummary
              leads += a.leadsTotal ?? 0; conv += a.leadsConverted ?? 0
              campaigns += a.campaignsSent ?? 0; calls += a.callVolume ?? 0
            } else {
              cr += (res.value as MeteringAccount).balance ?? 0
            }
          })
          setAnalytics({ callVolume: calls, leadsTotal: leads, leadsConverted: conv, campaignsSent: campaigns })
          setCredits(cr); setTier(null)
          setScope(any ? `${companies.length} companies` : '')
        }
      } catch { /* non-fatal */ }
    }
    loadMetrics()
    return () => { live = false }
  }, [currentCompany, companies])

  const buildOk = !buildStatus || buildStatus.status === 'ok'

  if (loading) {
    return <div className="sub" style={{ padding: '3rem', textAlign: 'center' }}>Loading workspace…</div>
  }
  if (error) {
    return (
      <div className="glass" style={{ padding: '1.5rem', borderColor: 'rgba(248,113,113,.4)' }}>
        <div style={{ color: 'var(--bad)', fontWeight: 700, marginBottom: 4 }}>Failed to load</div>
        <div className="sub">{error}</div>
      </div>
    )
  }

  const hasMetrics = analytics || adminHealth || credits != null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Hero */}
      <div className="reveal" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div className="h1">
            {greeting()} <span className="grad-text">✦</span>
          </div>
          <div className="sub" style={{ marginTop: 6, fontSize: '.86rem' }}>
            {companies.length} business{companies.length !== 1 ? 'es' : ''} onboarded
            {buildStatus?.sha ? <> · running <span className="mono">{buildStatus.sha.slice(0, 7)}</span></> : null}
          </div>
        </div>
        <Link className="btn btn-primary" to="/onboard" style={{ textDecoration: 'none' }}>
          <Icon name="onboard" size={15} /> Onboard a Business
        </Link>
      </div>

      {/* Bento metrics */}
      {hasMetrics && (
        <div className="bento">
          <StatCard delay="reveal-1" icon="coin" label="Credits" tone="var(--violet)"
            value={credits != null ? credits.toLocaleString() : '—'}
            sub={tier ? (
              <span className="pill" style={{ color: TIER_COLOR[tier], borderColor: TIER_COLOR[tier] + '55', background: TIER_COLOR[tier] + '18' }}>
                {tier.toUpperCase()}
              </span>
            ) : scope ? (
              <span className="sub">{scope}</span>
            ) : undefined} />
          <StatCard delay="reveal-2" icon="pin" label="Leads" tone="var(--info)"
            value={analytics?.leadsTotal != null ? String(analytics.leadsTotal) : '—'}
            sub={analytics && typeof analytics.leadsConverted === 'number' && (
              <span className="sub" style={{ color: 'var(--ok)' }}>{analytics.leadsConverted} converted</span>
            )} />
          <StatCard delay="reveal-3" icon="campaign" label="Campaigns Sent" tone="var(--brand)"
            value={analytics?.campaignsSent != null ? String(analytics.campaignsSent) : '—'} />
          <StatCard delay="reveal-4" icon="bolt" label="API Uptime"
            value={adminHealth ? formatUptime(adminHealth.api.uptime) : '—'}
            tone={adminHealth && adminHealth.api.status !== 'ok' ? 'var(--bad)' : undefined}
            sub={adminHealth && (
              <span className="pill" style={{ color: adminHealth.api.status === 'ok' ? 'var(--ok)' : 'var(--bad)',
                borderColor: (adminHealth.api.status === 'ok' ? 'var(--ok)' : 'var(--bad)') + '55' }}>
                {adminHealth.api.status}
              </span>
            )} />
        </div>
      )}

      {/* Companies */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="h2">Companies</div>
          {companies.length > 0 && <span className="sub">{companies.length} total</span>}
        </div>

        {companies.length === 0 ? (
          <div className="glass reveal" style={{
            padding: '3.5rem 2rem', textAlign: 'center', borderStyle: 'dashed', borderWidth: 2,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          }}>
            <div style={{
              width: 54, height: 54, borderRadius: 16, display: 'grid', placeItems: 'center',
              background: 'linear-gradient(140deg, rgba(129,140,248,.2), rgba(167,139,250,.08))',
              color: 'var(--brand)', marginBottom: 4,
            }}>
              <Icon name="company" size={26} />
            </div>
            <div style={{ fontWeight: 650, fontSize: '1.05rem' }}>No companies yet</div>
            <div className="sub" style={{ maxWidth: 340 }}>Onboard your first business to extract its DNA card and spawn its agents.</div>
            <Link className="btn btn-primary" to="/onboard" style={{ marginTop: 8, textDecoration: 'none' }}>
              <Icon name="onboard" size={15} /> Onboard a Business
            </Link>
          </div>
        ) : (
          <div className="bento">
            {companies.map((c, i) => (
              <div key={c.id} className={`col-4 reveal reveal-${Math.min(i + 1, 6)}`}>
                <CompanyCard company={c} health={healthMap[c.id] ?? null} buildOk={buildOk} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
