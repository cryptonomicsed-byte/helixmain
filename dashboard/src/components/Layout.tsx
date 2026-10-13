import { NavLink, Outlet } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { useEffect } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'
import { Icon } from './Icon'

/**
 * App chrome: no sidebar, no top bar — one thin icon-only bar fixed to the
 * BOTTOM (the Vantage StatusBar pattern).
 *   Left  — the Helix mark, which IS the main (Companies) tab.
 *   Right — Settings, which also holds Portfolio, Billing and Approvals.
 * No labels: icons only, so the bar stays thin.
 */
export function Layout() {
  const { buildStatus, setCompanies, setBuildStatus } = useHelixStore()

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
  const sha = buildStatus?.sha ? buildStatus.sha.slice(0, 7) : (buildStatus?.status ?? 'checking…')

  const icon = (active: boolean): CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: '.3rem', borderRadius: 9, textDecoration: 'none',
    color: active ? 'var(--fg)' : 'var(--fg-3)',
    background: active ? 'linear-gradient(90deg, rgba(129,140,248,.18), rgba(129,140,248,.04))' : 'transparent',
    transition: 'background 160ms, color 160ms',
  })

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="aurora" />

      {/* Content clears the fixed bar. */}
      <main className="reveal" style={{ padding: '22px 22px 74px' }}>
        <Outlet />
      </main>

      {/* ───── Bottom bar (icon only) ───── */}
      <nav style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 40,
        height: 42, display: 'flex', alignItems: 'center', gap: '.4rem', padding: '0 10px',
        background: 'linear-gradient(180deg, rgba(11,13,22,.74), rgba(11,13,22,.95))',
        borderTop: '1px solid var(--line)', backdropFilter: 'blur(16px)',
      }}>
        {/* Left — the Helix mark is the main (Companies) tab */}
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

        <div style={{ flex: 1 }} />

        {/* System status — dot only; the SHA is the tooltip */}
        <span title={ok ? `Systems nominal · ${sha}` : `Build failed · ${sha}`}
              style={{ display: 'inline-flex', alignItems: 'center', padding: '.3rem .15rem' }}>
          <span className={`dot ${ok ? '' : 'dot-bad'}`} style={{ color: ok ? 'var(--ok)' : 'var(--bad)' }} />
        </span>

        {/* Right — Settings (also Portfolio / Billing / Approvals) */}
        <NavLink to="/settings" style={({ isActive }) => icon(isActive)} title="Settings">
          <Icon name="settings" size={17} />
        </NavLink>
      </nav>
    </div>
  )
}
