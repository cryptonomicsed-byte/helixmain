import { authFetch } from '../api'
import { useState } from 'react'
import { useLeadsSeller } from './leads/LeadsContext'

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface LeadRow {
  id: string
  name: string
  company?: string
  website?: string
  phone?: string
  email: string
  score: number
  signals: string[]
  tier?: 'hot' | 'warm' | 'cold' | 'disqualified'
  status: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFootprintScore(signals: string[]): number {
  for (const s of signals) {
    const m = s.match(/^digitalFootprintScore:(\d+)$/)
    if (m) return parseInt(m[1], 10)
  }
  return -1
}

function FootprintBadge({ score }: { score: number }) {
  if (score < 0) return <span style={{ color: 'var(--fg-2)', fontSize: '0.8rem' }}>—</span>
  const bg = score >= 80 ? '#22543d' : score >= 40 ? '#744210' : '#742a2a'
  const color = score >= 80 ? 'var(--ok)' : score >= 40 ? 'var(--warn)' : 'var(--bad)'
  return (
    <span style={{
      background: bg, color, borderRadius: 4,
      padding: '2px 8px', fontSize: '0.78rem', fontWeight: 600,
    }}>
      {score}
    </span>
  )
}

function TierBadge({ tier }: { tier?: string }) {
  if (!tier) return null
  const map: Record<string, { icon: string; color: string }> = {
    hot:          { icon: '🔥', color: 'var(--bad)' },
    warm:         { icon: '♨️',  color: 'var(--warn)' },
    cold:         { icon: '🧊', color: 'var(--info)' },
    disqualified: { icon: '✗',  color: 'var(--fg-2)' },
  }
  const entry = map[tier]
  if (!entry) return null
  return (
    <span style={{ color: entry.color, fontSize: '0.82rem', fontWeight: 600 }}>
      {entry.icon} {tier}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function LeadHunterPage() {
  const currentCompany = useLeadsSeller()

  const [locMode, setLocMode]     = useState<'gps' | 'manual'>('gps')
  const [lat, setLat]             = useState('')
  const [lng, setLng]             = useState('')
  const [gpsError, setGpsError]   = useState('')
  const [industry, setIndustry]   = useState('')
  const [radius, setRadius]       = useState(5000)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [leads, setLeads]         = useState<LeadRow[]>([])
  const [qualifying, setQualifying] = useState<Record<string, boolean>>({})

  if (!currentCompany) {
    return (
      <div style={{ color: 'var(--fg-2)', padding: '2rem', textAlign: 'center' }}>
        Select a company from the header to use Lead Hunter.
      </div>
    )
  }

  function handleUseLocation() {
    setGpsError('')
    if (!navigator.geolocation) {
      setGpsError('Geolocation not supported by this browser.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(String(pos.coords.latitude))
        setLng(String(pos.coords.longitude))
      },
      (err) => setGpsError(`Could not get location: ${err.message}`),
    )
  }

  async function handleFindLeads() {
    const company = currentCompany
    if (!company) return
    if (!industry.trim()) { setError('Industry is required.'); return }
    const parsedLat = parseFloat(lat)
    const parsedLng = parseFloat(lng)
    if (isNaN(parsedLat) || isNaN(parsedLng)) {
      setError('Valid lat/lng required. Use "Use my location" or enter coordinates.')
      return
    }
    setError('')
    setLoading(true)
    try {
      const res = await authFetch('/sales/hunt/gps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: parsedLat,
          lng: parsedLng,
          industry: industry.trim(),
          radiusMeters: radius,
          companyId: company.id,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json() as { leads: LeadRow[] }
      setLeads(data.leads ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleQualify(leadId: string) {
    const company = currentCompany
    if (!company) return
    setQualifying((q) => ({ ...q, [leadId]: true }))
    try {
      const res = await authFetch(`/sales/qualify/${leadId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, cardId: company.id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { lead: LeadRow }
      setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, ...data.lead } : l))
    } catch (e) {
      console.warn('[LeadHunterPage] qualify error:', e)
    } finally {
      setQualifying((q) => ({ ...q, [leadId]: false }))
    }
  }

  const radiusKm = (radius / 1000).toFixed(1)

  return (
    <div style={{ color: 'var(--fg)', maxWidth: 1100 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.5rem', color: 'var(--fg)' }}>
        Lead Hunter
      </h1>

      {/* Controls card */}
      <div className="glass" style={{ background: 'var(--surface)', border: '1px solid var(--line-2)',
        borderRadius: 10, padding: '1.5rem', marginBottom: '1.5rem',
      }}>
        {/* Location mode toggle */}
        <div style={{ marginBottom: '1.25rem' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--fg-2)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Location
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.875rem' }}>
              <input
                type="radio" name="locmode" value="gps"
                checked={locMode === 'gps'}
                onChange={() => setLocMode('gps')}
                style={{ accentColor: 'var(--info)' }}
              />
              Use my location
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.875rem' }}>
              <input
                type="radio" name="locmode" value="manual"
                checked={locMode === 'manual'}
                onChange={() => setLocMode('manual')}
                style={{ accentColor: 'var(--info)' }}
              />
              Enter coordinates
            </label>
          </div>

          {locMode === 'gps' && (
            <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <button
                onClick={handleUseLocation}
                style={{
                  background: 'var(--line-2)', color: 'var(--fg)', border: '1px solid var(--line-2)',
                  borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.85rem',
                }}
              >
                📍 Get Location
              </button>
              {lat && lng && (
                <span style={{ fontSize: '0.82rem', color: 'var(--ok)' }}>
                  {parseFloat(lat).toFixed(5)}, {parseFloat(lng).toFixed(5)}
                </span>
              )}
              {gpsError && <span style={{ fontSize: '0.82rem', color: 'var(--bad)' }}>{gpsError}</span>}
            </div>
          )}

          {locMode === 'manual' && (
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--fg-2)', marginBottom: '0.25rem' }}>Latitude</div>
                <input
                  type="number" value={lat} onChange={(e) => setLat(e.target.value)}
                  placeholder="40.7128"
                  style={{
                    background: 'var(--bg)', border: '1px solid var(--line-2)', color: 'var(--fg)',
                    borderRadius: 6, padding: '0.4rem 0.75rem', fontSize: '0.875rem', width: 140,
                  }}
                />
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--fg-2)', marginBottom: '0.25rem' }}>Longitude</div>
                <input
                  type="number" value={lng} onChange={(e) => setLng(e.target.value)}
                  placeholder="-74.0060"
                  style={{
                    background: 'var(--bg)', border: '1px solid var(--line-2)', color: 'var(--fg)',
                    borderRadius: 6, padding: '0.4rem 0.75rem', fontSize: '0.875rem', width: 140,
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Industry + Radius row */}
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '1.25rem' }}>
          <div style={{ flex: '1 1 200px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--fg-2)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Industry
            </div>
            <input
              type="text" value={industry} onChange={(e) => setIndustry(e.target.value)}
              placeholder="e.g. barber, pizza, cafe"
              style={{
                width: '100%', background: 'var(--bg)', border: '1px solid var(--line-2)',
                color: 'var(--fg)', borderRadius: 6, padding: '0.4rem 0.75rem', fontSize: '0.875rem',
                boxSizing: 'border-box',
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleFindLeads()}
            />
          </div>

          <div style={{ flex: '1 1 240px' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--fg-2)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Radius — {radiusKm}km
            </div>
            <input
              type="range" min={500} max={10000} step={500}
              value={radius} onChange={(e) => setRadius(Number(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--info)' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--fg-2)', marginTop: '0.2rem' }}>
              <span>0.5km</span><span>10km</span>
            </div>
          </div>
        </div>

        {error && (
          <div style={{
            background: '#742a2a22', border: '1px solid #742a2a', borderRadius: 6,
            padding: '0.5rem 0.75rem', color: 'var(--bad)', fontSize: '0.85rem', marginBottom: '1rem',
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleFindLeads}
          disabled={loading}
          style={{
            background: loading ? 'var(--line-2)' : 'var(--info)', color: '#fff',
            border: 'none', borderRadius: 6, padding: '0.5rem 1.5rem',
            fontSize: '0.9rem', fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Searching…' : '🔍 Find Leads'}
        </button>
      </div>

      {/* Results table */}
      {leads.length > 0 && (
        <div className="glass" style={{ background: 'var(--surface)', border: '1px solid var(--line-2)',
          borderRadius: 10, overflow: 'hidden',
        }}>
          <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--line-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Results</span>
            <span style={{ fontSize: '0.8rem', color: 'var(--fg-2)' }}>{leads.length} leads found</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ background: 'var(--bg)' }}>
                  {['Name', 'Website', 'Phone', 'Footprint Score', 'Tier', 'Actions'].map((h) => (
                    <th key={h} style={{
                      padding: '0.6rem 1rem', textAlign: 'left', fontWeight: 600,
                      color: 'var(--fg-2)', fontSize: '0.78rem', textTransform: 'uppercase',
                      letterSpacing: '0.04em', whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {leads.map((lead, i) => (
                  <tr
                    key={lead.id}
                    style={{
                      borderTop: i > 0 ? '1px solid var(--line-2)' : undefined,
                      background: i % 2 === 0 ? 'transparent' : '#ffffff06',
                    }}
                  >
                    <td style={{ padding: '0.65rem 1rem', fontWeight: 500, color: 'var(--fg)' }}>
                      {lead.name}
                    </td>
                    <td style={{ padding: '0.65rem 1rem' }}>
                      {lead.website ? (
                        <a href={lead.website} target="_blank" rel="noopener noreferrer"
                          style={{ color: 'var(--info)', fontSize: '0.82rem', wordBreak: 'break-all' }}>
                          {lead.website.replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        <span style={{ color: 'var(--fg-2)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '0.65rem 1rem', color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>
                      {lead.phone ?? '—'}
                    </td>
                    <td style={{ padding: '0.65rem 1rem' }}>
                      <FootprintBadge score={extractFootprintScore(lead.signals)} />
                    </td>
                    <td style={{ padding: '0.65rem 1rem' }}>
                      <TierBadge tier={lead.tier} />
                    </td>
                    <td style={{ padding: '0.65rem 1rem' }}>
                      <button
                        onClick={() => handleQualify(lead.id)}
                        disabled={qualifying[lead.id]}
                        style={{
                          background: qualifying[lead.id] ? 'var(--line-2)' : '#2c5282',
                          color: '#bee3f8', border: 'none', borderRadius: 5,
                          padding: '0.3rem 0.75rem', fontSize: '0.8rem',
                          cursor: qualifying[lead.id] ? 'not-allowed' : 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {qualifying[lead.id] ? '…' : 'Qualify'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && leads.length === 0 && (
        <div style={{ color: 'var(--fg-2)', fontSize: '0.9rem', textAlign: 'center', padding: '2rem' }}>
          No leads yet. Configure your search above and click Find Leads.
        </div>
      )}
    </div>
  )
}
