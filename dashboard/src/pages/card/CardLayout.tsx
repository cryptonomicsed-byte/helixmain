import { NavLink, Outlet, useParams, useNavigate, Link } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import { useHelixStore } from '../../store'
import { api } from '../../api'
import { Icon } from '../../components/Icon'
import { AgentChat } from '../../components/AgentChat'
import { CardContext } from './CardContext'

// The card is the unit of work. Everything below lives inside /card/:id.
const TABS: { to: string; label: string; icon: string }[] = [
  { to: '',            label: 'Overview',   icon: 'dashboard' },
  { to: 'card',        label: 'Card',       icon: 'card' },
  { to: 'studio',      label: 'Studio',     icon: 'spark' },
  { to: 'site',        label: 'Site',       icon: 'globe' },
  { to: 'playground',  label: 'Playground', icon: 'flask' },
  { to: 'campaigns',   label: 'Campaigns',  icon: 'campaign' },
  { to: 'intel',       label: 'Intel',      icon: 'intel' },
  { to: 'settings',    label: 'Settings',   icon: 'settings' },
]

function healthTone(score: number): { color: string; label: string } {
  if (score >= 85) return { color: 'var(--ok)', label: 'Healthy' }
  if (score >= 60) return { color: 'var(--warn)', label: 'Needs work' }
  return { color: 'var(--bad)', label: 'Incomplete' }
}

export function CardLayout() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { companies, setCompanies, setCurrentCompany } = useHelixStore()

  const [card, setCard] = useState<any | null>(null)
  const [health, setHealth] = useState<any | null>(null)
  const [changelog, setChangelog] = useState<any | null>(null)
  const [hasSite, setHasSite] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  const reload = useCallback(() => setTick((t) => t + 1), [])

  // Route id is the source of truth — sync it into the store so any page that
  // still reads currentCompany keeps working without a dropdown.
  useEffect(() => {
    let live = true
    ;(async () => {
      let list = companies
      if (list.length === 0) {
        try { list = await api.listCompanies(); if (live) setCompanies(list) } catch { /* ignore */ }
      }
      if (live) setCurrentCompany(list.find((c) => c.id === id) ?? { id, name: id, cardVersion: 1, lastUpdated: '' })
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    ;(async () => {
      const [c, h, cl, sites] = await Promise.allSettled([
        api.getCardRaw(id), api.health(id), api.changelog(id), api.listSites(),
      ])
      if (!live) return
      if (c.status === 'fulfilled') setCard(c.value)
      else setError('Could not load this card.')
      setHealth(h.status === 'fulfilled' ? h.value : null)
      setChangelog(cl.status === 'fulfilled' ? cl.value : null)
      setHasSite(sites.status === 'fulfilled' && Array.isArray((sites.value as any)?.published) && (sites.value as any).published.includes(id))
      setLoading(false)
    })()
    return () => { live = false }
  }, [id, tick])

  const name = card?.identity?.name || card?.name?.value || id
  const tagline = card?.identity?.tagline || card?.tagline?.value || ''
  const score: number = typeof health?.score === 'number' ? health.score : 0
  const tone = healthTone(score)
  const version = card?.version ?? 1
  const hash = changelog?.entries?.[0]?.hash ?? ''
  const status: string = card?.status ?? 'draft'
  // The PUBLIC page (served by Hugo at /b/<id>/) — not the API preview endpoint.
  // This URL goes in the iframe, the "Open ↗" button, the QR code and the NFC
  // payload, all of which are meant to be used by someone who is NOT logged in.
  // An /api/... URL cannot do that: it needs x-api-key, so a scanned QR or a
  // tapped tag would just render an auth error.
  const publicUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/b/${id}/`

  if (loading) {
    return <div style={{ color: 'var(--fg-3)', padding: '3rem', textAlign: 'center' }}>Loading card…</div>
  }
  if (error) {
    return (
      <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--fg-2)' }}>
        <div style={{ marginBottom: '1rem' }}>{error}</div>
        <Link to="/" className="btn btn-ghost">← All companies</Link>
      </div>
    )
  }

  return (
    <CardContext.Provider value={{ id, card, health, changelog, loading, error, reload, publicUrl }}>
      <div style={{ color: 'var(--fg)' }}>
        {/* Breadcrumb */}
        <div style={{ marginBottom: '.75rem' }}>
          <Link to="/" className="sub" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
            <Icon name="arrow" size={13} style={{ transform: 'rotate(180deg)' }} /> All companies
          </Link>
        </div>

        {/* Persistent card header */}
        <div className="panel" style={{ padding: '1.1rem 1.25rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: '1.35rem', fontWeight: 750, letterSpacing: '-.02em', margin: 0 }}>{name}</h1>
                <span className="pill" style={{ color: tone.color, borderColor: tone.color, background: 'rgba(255,255,255,.03)' }}>
                  {score}% · {tone.label}
                </span>
                <span className="pill">{status}</span>
                <NavLink to={`/card/${id}/settings/history`} className="pill mono" style={{ textDecoration: 'none' }} onClick={(e) => { e.preventDefault(); navigate(`/card/${id}/settings/history`) }}>
                  v{version}{hash ? ` · ${hash.slice(0, 7)}` : ''}
                </NavLink>
              </div>
              {tagline && <div className="sub" style={{ marginTop: '.35rem', fontSize: '.86rem' }}>{tagline}</div>}
            </div>

            {/* Quick actions */}
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" disabled={!hasSite}
                title={hasSite ? 'Open the generated landing page' : 'No site generated yet'}
                onClick={() => hasSite && window.open(publicUrl, '_blank', 'noopener')}
                style={{ opacity: hasSite ? 1 : .5 }}>
                <Icon name="globe" size={15} /> Public page
              </button>
              <button className="btn btn-ghost" onClick={() => navigate(`/card/${id}/studio`)}>
                <Icon name="mic" size={15} /> Test call
              </button>
              <button className="btn btn-ghost" onClick={() => navigate(`/card/${id}/site`)}>
                <Icon name="qr" size={15} /> QR / NFC
              </button>
            </div>
          </div>
        </div>

        {/* Tab nav */}
        <div style={{
          display: 'flex', gap: '.25rem', overflowX: 'auto', paddingBottom: '.5rem', marginBottom: '1rem',
          borderBottom: '1px solid var(--line)',
        }}>
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to === '' ? `/card/${id}` : `/card/${id}/${t.to}`} end={t.to === ''}
              style={({ isActive }) => ({
                display: 'inline-flex', alignItems: 'center', gap: '.4rem', whiteSpace: 'nowrap',
                padding: '.4rem .7rem', borderRadius: 9, fontSize: '.83rem', textDecoration: 'none',
                color: isActive ? 'var(--fg)' : 'var(--fg-3)',
                fontWeight: isActive ? 600 : 450,
                background: isActive ? 'linear-gradient(90deg, rgba(129,140,248,.16), rgba(129,140,248,.03))' : 'transparent',
                transition: 'background 160ms, color 160ms',
              })}>
              <Icon name={t.icon} size={14} /> {t.label}
            </NavLink>
          ))}
        </div>

        <Outlet />
      </div>

      {/* In-card agent chat — the owner's conversational partner, on the card
          itself. Deliberately outside the tab Outlet so it survives tab changes. */}
      <AgentChat companyId={id} name={name} />
    </CardContext.Provider>
  )
}
