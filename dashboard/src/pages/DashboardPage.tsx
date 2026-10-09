import { useEffect, useState } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'
import { CompanyCard } from '../components/CompanyCard'
import type { HealthResult } from '../api'

export function DashboardPage() {
  const { companies, buildStatus, setCompanies, setBuildStatus } = useHelixStore()
  const [healthMap, setHealthMap] = useState<Record<string, HealthResult>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (live) setLoading(false)
      }
    }
    load()
    return () => { live = false }
  }, [setCompanies, setBuildStatus])

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
