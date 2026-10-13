import { Outlet } from 'react-router-dom'
import { useEffect } from 'react'
import { useHelixStore } from '../../store'
import { api, auth } from '../../api'
import { SubNav, type SubTab } from '../../components/SubNav'

// Leads belong to the ACCOUNT OWNER — finding new clients (businesses that
// could use HelixMain) — not to any one card. That is exactly why this lives at
// the top level and not as a card tab. The seller identity defaults to the
// account itself (the session company IS the account id server-side); you can
// still point a hunt at one of your own businesses from the selector.
const TABS: SubTab[] = [
  { to: '/leads',          label: 'Discover', icon: 'search',   end: true },
  { to: '/leads/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { to: '/leads/schedule', label: 'Schedule', icon: 'calendar' },
]

const selectStyle = {
  background: 'rgba(0,0,0,.28)', border: '1px solid var(--line-2)', borderRadius: 9,
  color: 'var(--fg)', padding: '.35rem .55rem', fontSize: '.82rem', outline: 'none', maxWidth: 320,
}

export function LeadsLayout() {
  const { companies, currentCompany, setCurrentCompany, setCompanies } = useHelixStore()

  // Default the seller to the ACCOUNT (owner prospecting), only when nothing is
  // selected — an explicit pick always wins.
  useEffect(() => {
    let live = true
    ;(async () => {
      if (useHelixStore.getState().companies.length === 0) {
        try { const list = await api.listCompanies(); if (live) setCompanies(list) } catch { /* ignore */ }
      }
      if (!useHelixStore.getState().currentCompany) {
        try {
          const me = await auth.me()
          if (live && me?.company) {
            setCurrentCompany({ id: me.company, name: 'My account — owner prospecting', cardVersion: 1, lastUpdated: '' })
          }
        } catch { /* ignore — the pages show their own empty state */ }
      }
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const orphan = currentCompany && !companies.some((c) => c.id === currentCompany.id)

  const selector = (
    <label className="sub" style={{ display: 'inline-flex', alignItems: 'center', gap: '.5rem' }}>
      Prospecting as
      <select
        style={selectStyle}
        value={currentCompany?.id ?? ''}
        onChange={(e) => {
          const id = e.target.value
          const c = companies.find((x) => x.id === id)
          setCurrentCompany(c ?? (id ? { id, name: id, cardVersion: 1, lastUpdated: '' } : null))
        }}
      >
        {orphan && <option value={currentCompany!.id}>{currentCompany!.name}</option>}
        {companies.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
        {!orphan && !currentCompany && <option value="">— select —</option>}
      </select>
    </label>
  )

  return (
    <div>
      <div className="reveal" style={{ marginBottom: '1rem' }}>
        <div className="h1">Leads</div>
        <div className="sub" style={{ marginTop: 4 }}>
          Find new clients for your account — businesses that could use HelixMain. Prospect, qualify,
          and work them through the pipeline. These are <em>your</em> leads, not a customer's.
        </div>
      </div>

      <SubNav tabs={TABS} right={selector} />

      <Outlet />
    </div>
  )
}
