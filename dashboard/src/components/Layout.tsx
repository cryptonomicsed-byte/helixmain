import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'

const NAV_LINKS = [
  { to: '/',              label: 'Dashboard',    icon: '⬛' },
  { to: '/onboard',       label: 'Onboard',      icon: '➕' },
  { to: '/approvals',     label: 'Approvals',    icon: '🔔' },
  { to: '/playground',    label: 'Playground',   icon: '🧪' },
  { to: '/leads',         label: 'Leads',        icon: '📍' },
  { to: '/pipeline',      label: 'Pipeline',     icon: '📊' },
  { to: '/intel',         label: 'Intel',        icon: '⚔' },
  { to: '/campaigns',     label: 'Campaigns',    icon: '📣' },
  { to: '/schedule',      label: 'Schedule',     icon: '📅' },
  { to: '/voice-studio',  label: 'Voice Studio', icon: '🎙' },
]

const sidebarStyle: React.CSSProperties = {
  width: 220, minHeight: '100vh', background: '#13172a',
  borderRight: '1px solid #1e2433', display: 'flex', flexDirection: 'column',
  padding: '1.5rem 0', flexShrink: 0,
}

const navLinkBase: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.6rem',
  padding: '0.55rem 1.25rem', fontSize: '0.875rem', color: '#94a3b8',
  textDecoration: 'none', borderRadius: '0 8px 8px 0', marginRight: '0.75rem',
  transition: 'background 0.12s, color 0.12s',
}

export function Layout() {
  const { companies, buildStatus, setCompanies, setBuildStatus, currentCompany, setCurrentCompany } = useHelixStore()
  const navigate = useNavigate()

  // Poll build status every 30s
  useEffect(() => {
    let live = true
    async function poll() {
      try {
        const s = await api.buildStatus()
        if (live) setBuildStatus(s)
      } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 30_000)
    return () => { live = false; clearInterval(t) }
  }, [setBuildStatus])

  // Load companies once
  useEffect(() => {
    api.listCompanies()
      .then(setCompanies)
      .catch(() => {/* not fatal */})
  }, [setCompanies])

  const buildOk = !buildStatus || buildStatus.status === 'ok'

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0f1117' }}>
      {/* Sidebar */}
      <nav style={sidebarStyle}>
        {/* Logo */}
        <div style={{ padding: '0 1.25rem 1.5rem', borderBottom: '1px solid #1e2433', marginBottom: '1rem' }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#818cf8', letterSpacing: '-0.01em' }}>
            Helix<span style={{ color: '#6366f1' }}>Main</span>
          </div>
          <div style={{ fontSize: '0.7rem', color: '#475569', marginTop: '0.15rem' }}>Owner Dashboard</div>
        </div>

        {/* Nav links */}
        {NAV_LINKS.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            style={({ isActive }) => ({
              ...navLinkBase,
              background: isActive ? '#6366f122' : 'transparent',
              color: isActive ? '#818cf8' : '#94a3b8',
              fontWeight: isActive ? 600 : 400,
            })}
          >
            <span style={{ fontSize: '0.9rem', opacity: 0.7 }}>{icon}</span>
            {label}
          </NavLink>
        ))}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Build status footer */}
        <div style={{
          padding: '0.75rem 1.25rem', borderTop: '1px solid #1e2433',
          display: 'flex', alignItems: 'center', gap: '0.5rem',
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
            background: buildOk ? '#22c55e' : '#ef4444',
          }} />
          <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
            {buildStatus?.status ?? 'checking…'}
          </span>
        </div>
      </nav>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Top bar */}
        <header style={{
          height: 52, background: '#13172a', borderBottom: '1px solid #1e2433',
          display: 'flex', alignItems: 'center', padding: '0 1.5rem', gap: '1rem',
        }}>
          <div style={{ flex: 1 }} />

          {/* Company selector */}
          <select
            value={currentCompany?.id ?? ''}
            onChange={(e) => {
              const c = companies.find((x) => x.id === e.target.value) ?? null
              setCurrentCompany(c)
              if (c) navigate(`/company/${c.id}`)
            }}
            style={{
              background: '#0f1117', border: '1px solid #2d3748', color: '#e2e8f0',
              borderRadius: 6, padding: '0.3rem 0.6rem', fontSize: '0.82rem',
              cursor: 'pointer', outline: 'none', minWidth: 160,
            }}
          >
            <option value="">— select company —</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, padding: '1.75rem', overflowY: 'auto' }}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
