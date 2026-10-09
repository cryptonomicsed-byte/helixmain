import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'
import { Icon } from './Icon'
import { CompanySwitcher } from './CompanySwitcher'

const NAV: { group: string; items: { to: string; label: string; icon: string }[] }[] = [
  { group: 'Workspace', items: [
    { to: '/',         label: 'Dashboard', icon: 'dashboard' },
    { to: '/onboard',  label: 'Onboard',   icon: 'onboard' },
  ]},
  { group: 'Operate', items: [
    { to: '/approvals',    label: 'Approvals',    icon: 'approvals' },
    { to: '/playground',   label: 'Playground',   icon: 'flask' },
    { to: '/voice-studio', label: 'Voice Studio', icon: 'mic' },
  ]},
  { group: 'Grow', items: [
    { to: '/leads',     label: 'Leads',     icon: 'pin' },
    { to: '/pipeline',  label: 'Pipeline',  icon: 'pipeline' },
    { to: '/campaigns', label: 'Campaigns', icon: 'campaign' },
    { to: '/schedule',  label: 'Schedule',  icon: 'calendar' },
  ]},
  { group: 'Assets', items: [
    { to: '/intel',     label: 'Intel',     icon: 'intel' },
    { to: '/portfolio', label: 'Portfolio', icon: 'folder' },
    { to: '/billing',   label: 'Billing',   icon: 'card' },
  ]},
]

const TITLES: Record<string, string> = {
  '/': 'Dashboard', '/onboard': 'Onboard a Business', '/approvals': 'Approvals',
  '/playground': 'Playground', '/leads': 'Lead Hunter', '/pipeline': 'Sales Pipeline',
  '/intel': 'Intel', '/campaigns': 'Campaigns', '/schedule': 'Schedule',
  '/voice-studio': 'Voice Studio', '/portfolio': 'Portfolio', '/billing': 'Billing',
}

export function Layout() {
  const { buildStatus, setCompanies, setBuildStatus } = useHelixStore()
  const { pathname } = useLocation()
  const title = pathname.startsWith('/company') ? 'Company' : (TITLES[pathname] ?? 'HelixMain')

  useEffect(() => {
    let live = true
    async function poll() {
      try { const s = await api.buildStatus(); if (live) setBuildStatus(s) } catch { /* ignore */ }
    }
    poll()
    const t = setInterval(poll, 30_000)
    return () => { live = false; clearInterval(t) }
  }, [setBuildStatus])

  useEffect(() => { api.listCompanies().then(setCompanies).catch(() => {}) }, [setCompanies])

  const ok = !buildStatus || buildStatus.status === 'ok'

  return (
    <div style={{ display: 'flex', minHeight: '100vh', position: 'relative' }}>
      <div className="aurora" />

      {/* ───── Sidebar ───── */}
      <nav style={{
        width: 236, flexShrink: 0, position: 'sticky', top: 0, height: '100vh',
        display: 'flex', flexDirection: 'column', padding: '18px 12px',
        background: 'linear-gradient(180deg, rgba(19,23,42,.72), rgba(11,13,22,.72))',
        borderRight: '1px solid var(--line)', backdropFilter: 'blur(16px)', zIndex: 20,
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '4px 8px 18px' }}>
          <div style={{
            width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center',
            background: 'linear-gradient(140deg, var(--brand), var(--violet))', boxShadow: 'var(--glow)',
            color: 'var(--bg)',
          }}>
            <Icon name="bolt" size={17} />
          </div>
          <div>
            <div style={{ fontWeight: 750, letterSpacing: '-.02em', fontSize: '1rem' }}>
              Helix<span className="grad-text">Main</span>
            </div>
            <div className="sub" style={{ fontSize: '.68rem', lineHeight: 1 }}>Owner Dashboard</div>
          </div>
        </div>

        {/* Nav */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {NAV.map((sec) => (
            <div key={sec.group}>
              <div style={{ fontSize: '.62rem', textTransform: 'uppercase', letterSpacing: '.09em', color: 'var(--fg-3)', padding: '0 10px 6px', fontWeight: 600 }}>
                {sec.group}
              </div>
              {sec.items.map(({ to, label, icon }) => (
                <NavLink key={to} to={to} end={to === '/'}
                  style={({ isActive }) => ({
                    display: 'flex', alignItems: 'center', gap: '.65rem',
                    padding: '.5rem .6rem', borderRadius: 10, marginBottom: 2,
                    fontSize: '.85rem', textDecoration: 'none', position: 'relative',
                    color: isActive ? 'var(--fg)' : 'var(--fg-3)',
                    fontWeight: isActive ? 600 : 450,
                    background: isActive ? 'linear-gradient(90deg, rgba(129,140,248,.16), rgba(129,140,248,.03))' : 'transparent',
                    transition: 'background 160ms, color 160ms',
                  })}>
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span style={{
                          position: 'absolute', left: -12, top: '50%', transform: 'translateY(-50%)',
                          width: 3, height: 18, borderRadius: 2,
                          background: 'linear-gradient(180deg, var(--brand), var(--violet))',
                          boxShadow: '0 0 12px var(--brand)',
                        }} />
                      )}
                      <Icon name={icon} size={16} />
                      {label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </div>

        {/* Status footer */}
        <div style={{
          marginTop: 10, padding: '10px 10px 4px', borderTop: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', gap: '.55rem',
        }}>
          <span className={`dot ${ok ? '' : 'dot-bad'}`} style={{ color: ok ? 'var(--ok)' : 'var(--bad)' }} />
          <div style={{ lineHeight: 1.25 }}>
            <div style={{ fontSize: '.74rem', color: 'var(--fg-2)', fontWeight: 600 }}>
              {ok ? 'Systems nominal' : 'Build failed'}
            </div>
            <div className="sub mono" style={{ fontSize: '.62rem' }}>
              {buildStatus?.sha ? buildStatus.sha.slice(0, 7) : buildStatus?.status ?? 'checking…'}
            </div>
          </div>
        </div>
      </nav>

      {/* ───── Main ───── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, zIndex: 10 }}>
        <header style={{
          height: 60, flexShrink: 0, position: 'sticky', top: 0, zIndex: 30,
          display: 'flex', alignItems: 'center', gap: '1rem', padding: '0 24px',
          background: 'rgba(11,13,22,.62)', borderBottom: '1px solid var(--line)',
          backdropFilter: 'blur(16px)',
        }}>
          <div className="h2">{title}</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" title="Notifications" style={{ padding: '.45rem' }}>
            <Icon name="bell" size={17} />
          </button>
          <CompanySwitcher />
        </header>

        <main key={pathname} className="reveal" style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
