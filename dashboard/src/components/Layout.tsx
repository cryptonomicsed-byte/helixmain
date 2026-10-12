import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useHelixStore } from '../store'
import { api, signOut } from '../api'
import { Icon } from './Icon'
import { useIsMobile } from '../hooks'

const NAV: { group: string; items: { to: string; label: string; icon: string }[] }[] = [
  { group: 'Workspace', items: [
    { to: '/',         label: 'Companies', icon: 'dashboard' },
    { to: '/onboard',  label: 'Onboard',   icon: 'onboard' },
  ]},
  { group: 'Control', items: [
    { to: '/approvals', label: 'Approvals', icon: 'approvals' },
    { to: '/settings',  label: 'Settings',  icon: 'settings' },
  ]},
  { group: 'Account', items: [
    { to: '/portfolio', label: 'Portfolio', icon: 'folder' },
    { to: '/billing',   label: 'Billing',   icon: 'card' },
  ]},
]

const TITLES: Record<string, string> = {
  '/': 'Companies', '/onboard': 'Onboard a Business', '/approvals': 'Approvals',
  '/settings': 'Settings', '/portfolio': 'Portfolio', '/billing': 'Billing',
}

const RAIL_W = 68
const FULL_W = 236

export function Layout() {
  const { buildStatus, setCompanies, setBuildStatus } = useHelixStore()
  const { pathname } = useLocation()
  // Inside a card the card's own header carries the context — no global title,
  // no business dropdown. The card IS the page.
  const inCard = pathname.startsWith('/card/')
  const title = inCard ? '' : (TITLES[pathname] ?? '')
  const isMobile = useIsMobile()

  // Signing out clears the server session and reloads, so the button stays
  // disabled from the click onward — a second click would race the reload.
  const [signingOut, setSigningOut] = useState(false)
  const doSignOut = () => { setSigningOut(true); void signOut() }

  // Desktop: collapse the sidebar to an icon rail (persisted).
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('helix_sidebar_collapsed') === '1' } catch { return false }
  })
  // Mobile: off-canvas drawer.
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    try { localStorage.setItem('helix_sidebar_collapsed', collapsed ? '1' : '0') } catch { /* ignore */ }
  }, [collapsed])

  // Any navigation closes the mobile drawer.
  useEffect(() => { setDrawerOpen(false) }, [pathname])

  // Esc closes the mobile drawer.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen])

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

  // Labels show unless collapsed on desktop; always show inside the mobile drawer.
  const showLabels = isMobile || !collapsed

  const navStyle: CSSProperties = isMobile
    ? {
        position: 'fixed', top: 0, left: 0, height: '100vh', width: FULL_W + 8,
        display: 'flex', flexDirection: 'column', padding: '18px 12px',
        background: 'linear-gradient(180deg, rgba(19,23,42,.97), rgba(11,13,22,.97))',
        borderRight: '1px solid var(--line)', backdropFilter: 'blur(18px)', zIndex: 60,
        transform: drawerOpen ? 'translateX(0)' : 'translateX(-105%)',
        transition: 'transform 240ms cubic-bezier(.22,1,.36,1)',
        boxShadow: drawerOpen ? '0 0 40px #000000aa' : 'none',
      }
    : {
        width: collapsed ? RAIL_W : FULL_W, flexShrink: 0, position: 'sticky', top: 0, height: '100vh',
        display: 'flex', flexDirection: 'column', padding: '18px 12px',
        background: 'linear-gradient(180deg, rgba(19,23,42,.72), rgba(11,13,22,.72))',
        borderRight: '1px solid var(--line)', backdropFilter: 'blur(16px)', zIndex: 20,
        transition: 'width 220ms cubic-bezier(.22,1,.36,1)',
      }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', position: 'relative' }}>
      <div className="aurora" />

      {/* Mobile backdrop */}
      {isMobile && drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          style={{ position: 'fixed', inset: 0, background: '#00000077', zIndex: 55, backdropFilter: 'blur(2px)' }}
        />
      )}

      {/* ───── Sidebar ───── */}
      <nav style={navStyle}>
        {/* Brand + collapse toggle */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '.6rem',
          padding: showLabels ? '4px 8px 18px' : '4px 0 18px',
          justifyContent: showLabels ? 'flex-start' : 'center',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', flexShrink: 0,
            background: 'linear-gradient(140deg, var(--brand), var(--violet))', boxShadow: 'var(--glow)',
            color: 'var(--bg)',
          }}>
            <Icon name="bolt" size={17} />
          </div>
          {showLabels && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 750, letterSpacing: '-.02em', fontSize: '1rem' }}>
                Helix<span className="grad-text">Main</span>
              </div>
              <div className="sub" style={{ fontSize: '.68rem', lineHeight: 1 }}>Owner Dashboard</div>
            </div>
          )}
          {/* Desktop collapse control */}
          {!isMobile && (
            <button
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? 'Expand menu' : 'Collapse menu'}
              aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
              style={{
                background: 'transparent', border: '1px solid var(--line)', borderRadius: 8,
                color: 'var(--fg-3)', cursor: 'pointer', padding: '.3rem', display: 'grid', placeItems: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="panel" size={15} />
            </button>
          )}
          {/* Mobile close control */}
          {isMobile && (
            <button
              onClick={() => setDrawerOpen(false)}
              title="Close menu"
              aria-label="Close menu"
              style={{
                marginLeft: 'auto', background: 'transparent', border: 'none',
                color: 'var(--fg-3)', cursor: 'pointer', padding: '.3rem', display: 'grid', placeItems: 'center',
              }}
            >
              <Icon name="x" size={18} />
            </button>
          )}
        </div>

        {/* Nav */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {NAV.map((sec) => (
            <div key={sec.group}>
              {showLabels && (
                <div style={{ fontSize: '.62rem', textTransform: 'uppercase', letterSpacing: '.09em', color: 'var(--fg-3)', padding: '0 10px 6px', fontWeight: 600 }}>
                  {sec.group}
                </div>
              )}
              {sec.items.map(({ to, label, icon }) => (
                <NavLink key={to} to={to} end={to === '/'} title={showLabels ? undefined : label}
                  style={({ isActive }) => ({
                    display: 'flex', alignItems: 'center', gap: showLabels ? '.65rem' : 0,
                    justifyContent: showLabels ? 'flex-start' : 'center',
                    padding: showLabels ? '.5rem .6rem' : '.55rem 0', borderRadius: 10, marginBottom: 2,
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
                          position: 'absolute', left: showLabels ? -12 : -8, top: '50%', transform: 'translateY(-50%)',
                          width: 3, height: 18, borderRadius: 2,
                          background: 'linear-gradient(180deg, var(--brand), var(--violet))',
                          boxShadow: '0 0 12px var(--brand)',
                        }} />
                      )}
                      <Icon name={icon} size={16} />
                      {showLabels && label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </div>

        {/* Sign out. In the rail as well as the header: on mobile the drawer is
            what you actually open, and a control that only exists in the header
            would be unreachable behind the hamburger. */}
        <button
          className="btn btn-ghost"
          onClick={doSignOut}
          disabled={signingOut}
          title={showLabels ? undefined : 'Sign out'}
          style={{
            marginTop: 10, padding: '.55rem', width: '100%',
            display: 'flex', alignItems: 'center', gap: '.55rem',
            justifyContent: showLabels ? 'flex-start' : 'center',
          }}
        >
          <Icon name="logout" size={16} />
          {showLabels && (
            <span style={{ fontSize: '.8rem' }}>{signingOut ? 'Signing out…' : 'Sign out'}</span>
          )}
        </button>

        {/* Status footer */}
        <div style={{
          marginTop: 10, padding: '10px 10px 4px', borderTop: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', gap: '.55rem',
          justifyContent: showLabels ? 'flex-start' : 'center',
        }}>
          <span className={`dot ${ok ? '' : 'dot-bad'}`} style={{ color: ok ? 'var(--ok)' : 'var(--bad)' }} />
          {showLabels && (
            <div style={{ lineHeight: 1.25, minWidth: 0 }}>
              <div style={{ fontSize: '.74rem', color: 'var(--fg-2)', fontWeight: 600 }}>
                {ok ? 'Systems nominal' : 'Build failed'}
              </div>
              <div className="sub mono" style={{ fontSize: '.62rem' }}>
                {buildStatus?.sha ? buildStatus.sha.slice(0, 7) : buildStatus?.status ?? 'checking…'}
              </div>
            </div>
          )}
        </div>
      </nav>

      {/* ───── Main ───── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, zIndex: 10 }}>
        <header style={{
          height: 60, flexShrink: 0, position: 'sticky', top: 0, zIndex: 30,
          display: 'flex', alignItems: 'center', gap: '.65rem',
          padding: isMobile ? '0 14px' : '0 24px',
          background: 'rgba(11,13,22,.62)', borderBottom: '1px solid var(--line)',
          backdropFilter: 'blur(16px)',
        }}>
          {/* Hamburger — mobile only */}
          {isMobile && (
            <button
              className="btn btn-ghost"
              onClick={() => setDrawerOpen(true)}
              title="Open menu"
              aria-label="Open menu"
              style={{ padding: '.45rem' }}
            >
              <Icon name="menu" size={19} />
            </button>
          )}
          {!isMobile && collapsed && (
            <button
              className="btn btn-ghost"
              onClick={() => setCollapsed(false)}
              title="Expand menu"
              aria-label="Expand menu"
              style={{ padding: '.45rem' }}
            >
              <Icon name="menu" size={19} />
            </button>
          )}

          {title && (
            <div className="h2" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }} />
          {!isMobile && (
            <button className="btn btn-ghost" title="Notifications" style={{ padding: '.45rem' }}>
              <Icon name="bell" size={17} />
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={doSignOut}
            disabled={signingOut}
            title="Sign out"
            aria-label="Sign out"
            style={{ padding: '.45rem' }}
          >
            <Icon name="logout" size={17} />
          </button>
        </header>

        <main
          key={pathname}
          className="reveal"
          style={{ flex: 1, padding: isMobile ? 14 : 24, overflowY: 'auto' }}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}
