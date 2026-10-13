import { NavLink, Outlet } from 'react-router-dom'
import type { CSSProperties } from 'react'
import { useEffect } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'
import { Icon } from './Icon'

/**
 * App chrome: no sidebar, no top bar — one thin bar fixed to the BOTTOM (the
 * Vantage StatusBar pattern).
 *   Left  — the Helix mark, which IS the main (Companies) tab.
 *   Right — Settings, which now also holds Portfolio, Billing and Approvals.
 * Everything else lives inside the page itself.
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

  const barItem = (active: boolean): CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '.5rem',
    padding: '.35rem .6rem', borderRadius: 10, textDecoration: 'none',
    color: active ? 'var(--fg)' : 'var(--fg-3)',
    fontWeight: active ? 650 : 450, fontSize: '.86rem',
    background: active ? 'linear-gradient(90deg, rgba(129,140,248,.18), rgba(129,140,248,.04))' : 'transparent',
    transition: 'background 160ms, color 160ms', whiteSpace: 'nowrap',
  })

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="aurora" />

      {/* Content clears the fixed bar. */}
      <main className="reveal" style={{ padding: '22px 22px 96px' }}>
        <Outlet />
      </main>

      {/* ───── Bottom bar ───── */}
      <nav style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 40,
        height: 58, display: 'flex', alignItems: 'center', gap: '.5rem', padding: '0 12px',
        background: 'linear-gradient(180deg, rgba(11,13,22,.74), rgba(11,13,22,.95))',
        borderTop: '1px solid var(--line)', backdropFilter: 'blur(16px)',
      }}>
        {/* Left — the Helix mark is the main (Companies) tab */}
        <NavLink to="/" end style={({ isActive }) => barItem(isActive)} title="Companies">
          {({ isActive }) => (
            <>
              <span style={{
                width: 28, height: 28, borderRadius: 9, display: 'grid', placeItems: 'center', flexShrink: 0,
                background: 'linear-gradient(140deg, var(--brand), var(--violet))',
                boxShadow: isActive ? 'var(--glow)' : 'none', color: 'var(--bg)',
              }}>
                <Icon name="bolt" size={15} />
              </span>
              <span style={{ fontWeight: 750, letterSpacing: '-.02em', fontSize: '.95rem' }}>
                Helix<span className="grad-text">Main</span>
              </span>
            </>
          )}
        </NavLink>

        <div style={{ flex: 1 }} />

        {/* System status */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem', paddingRight: '.3rem' }}
              title={ok ? 'Systems nominal' : 'Build failed'}>
          <span className={`dot ${ok ? '' : 'dot-bad'}`} style={{ color: ok ? 'var(--ok)' : 'var(--bad)' }} />
          <span className="sub mono" style={{ fontSize: '.64rem' }}>
            {buildStatus?.sha ? buildStatus.sha.slice(0, 7) : (buildStatus?.status ?? '…')}
          </span>
        </span>

        {/* Right — Settings (also Portfolio / Billing / Approvals) */}
        <NavLink to="/settings" style={({ isActive }) => barItem(isActive)} title="Settings">
          <Icon name="settings" size={16} /> Settings
        </NavLink>
      </nav>
    </div>
  )
}
