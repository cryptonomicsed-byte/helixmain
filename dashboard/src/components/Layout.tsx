import { NavLink, Outlet, useLocation } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'
import { Icon } from './Icon'

/**
 * App chrome: no sidebar, no top bar — one thin icon-only bar fixed to the
 * BOTTOM (the Vantage StatusBar pattern).
 *
 * The two ends are CONTEXTUAL, not fixed furniture:
 *   Right — Settings, only from the DASHBOARD (that is where you decide to go
 *           into the account section).
 *   Left  — the Helix mark (= the Companies dashboard), only from the Settings
 *           and Leads sections, i.e. the way back out of them.
 * Card pages get neither: CardLayout carries its own "← All companies" link, and
 * the bar is not rendered at all when it would have nothing to show (an empty
 * chrome strip with a top border is worse than no strip).
 *
 * The old permanent system-status dot is gone — it sat between the two ends
 * (visually attached to Settings) and pinged green forever. The dashboard's own
 * header still reports the running SHA.
 *
 * No labels: icons only, so the bar stays thin.
 */
export function Layout() {
  const { setCompanies } = useHelixStore()
  const { pathname } = useLocation()

  // Which end of the bar belongs to this route. Kept as two explicit reads so the
  // intent is legible at the call site rather than buried in a ternary.
  const onDashboard = pathname === '/'
  const inSection = pathname.startsWith('/settings') || pathname.startsWith('/leads')

  useEffect(() => { api.listCompanies().then(setCompanies).catch(() => {}) }, [setCompanies])

  // Fade the bar's chrome in once scrolled, out again at the top — the landing
  // header's `scrollY > 12` rule. Passive listener; no work when the page cannot
  // scroll, since scrollY simply stays 0.
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const icon = (active: boolean): CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: '.3rem', borderRadius: 9, textDecoration: 'none',
    color: active ? 'var(--fg)' : 'var(--fg-3)',
    background: active ? 'linear-gradient(90deg, rgba(129,140,248,.18), rgba(129,140,248,.04))' : 'transparent',
    transition: 'background 160ms, color 160ms',
  })

  // Nothing to show on this route → no chrome at all.
  const hasBar = onDashboard || inSection

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="aurora" />

      {/* Content clears the fixed bar. */}
      <main className="reveal" style={{ padding: '22px 22px 74px' }}>
        <Outlet />
      </main>

      {/* ───── Bottom bar (icon only) ─────
          background / border-top / backdrop-filter live in .bottombar (theme.css) so
          they can be TRANSITIONED — an inline style would win over the class and the
          fade could never happen. */}
      {hasBar && (
        <nav className={'bottombar' + (scrolled ? ' is-scrolled' : '')} style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 40,
          height: 42, display: 'flex', alignItems: 'center', gap: '.4rem', padding: '0 10px',
        }}>
          {/* Left — the Helix mark is the Companies dashboard: the way BACK, so it
              belongs to the sections, never to the dashboard itself. */}
          {inSection && (
            <NavLink to="/" end style={({ isActive }) => icon(isActive)} title="Companies">
              {({ isActive }) => (
                <span style={{
                  width: 24, height: 24, borderRadius: 7, display: 'grid', placeItems: 'center', flexShrink: 0,
                  background: 'linear-gradient(140deg, var(--brand), var(--violet))',
                  boxShadow: isActive ? 'var(--glow)' : 'none', color: 'var(--bg)',
                  opacity: isActive ? 1 : 0.7, transition: 'opacity 160ms',
                }}>
                  <Icon name="bolt" size={14} />
                </span>
              )}
            </NavLink>
          )}

          <div style={{ flex: 1 }} />

          {/* Right — Settings, offered only from the dashboard. */}
          {onDashboard && (
            <NavLink to="/settings" style={({ isActive }) => icon(isActive)} title="Settings">
              <Icon name="settings" size={17} />
            </NavLink>
          )}
        </nav>
      )}
    </div>
  )
}
