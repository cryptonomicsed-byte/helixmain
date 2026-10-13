import { Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { SubNav, type SubTab } from '../components/SubNav'
import { api, signOut } from '../api'
import { Icon } from '../components/Icon'

/**
 * Settings — the account-level section. The sidebar's Control + Account groups
 * fold in here: AI & keys, Portfolio, Billing and Approvals are sub-tabs of one
 * page, reached from the Settings item at the right of the bottom bar. Sign out
 * lives here too (the old top-bar logout is gone).
 */
export function SettingsLayout() {
  const [pending, setPending] = useState<number | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    let live = true
    const poll = async () => {
      try {
        const d = await api.gkQueue()
        if (live) setPending((d.pending ?? []).length)
      } catch { if (live) setPending(null) }
    }
    poll()
    const t = setInterval(poll, 5000)
    return () => { live = false; clearInterval(t) }
  }, [])

  const tabs: SubTab[] = [
    { to: '/settings',           label: 'AI & Keys', icon: 'settings',  end: true },
    { to: '/settings/portfolio', label: 'Portfolio', icon: 'folder' },
    { to: '/settings/billing',   label: 'Billing',   icon: 'card' },
    { to: '/settings/approvals', label: 'Approvals', icon: 'approvals', badge: pending ?? undefined },
  ]

  return (
    <div>
      <div className="reveal" style={{ marginBottom: '1rem' }}>
        <div className="h1">Settings</div>
        <div className="sub" style={{ marginTop: 4 }}>
          Account settings — model &amp; keys, portfolio, billing and approvals.
        </div>
      </div>

      <SubNav tabs={tabs} />

      <Outlet />

      <div className="glass" style={{
        marginTop: '2rem', padding: '1rem 1.25rem',
        display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap',
      }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '.9rem' }}>Sign out</div>
          <div className="sub">End this session on this device.</div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" disabled={signingOut}
          onClick={() => { setSigningOut(true); void signOut() }}>
          <Icon name="logout" size={15} /> {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  )
}
