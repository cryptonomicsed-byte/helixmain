import { Outlet } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { useHelixStore } from '../../store'
import { api, auth } from '../../api'
import { SubNav, type SubTab } from '../../components/SubNav'
import { LeadsContext, type LeadsSeller } from './LeadsContext'

// Leads belong to the ACCOUNT OWNER — finding new clients (businesses that could
// use HelixMain) — not to any one card. That is exactly why this lives at the top
// level and not as a card tab. The seller defaults to the ACCOUNT itself (the
// session company IS the account id server-side); the selector points a hunt at
// one of your own businesses instead.
//
// The seller is held HERE and passed down through LeadsContext. It is NOT written
// into the global `currentCompany` store: other pages (Dashboard scope, Billing,
// Greeting) read that, and the account is not a company.
const TABS: SubTab[] = [
  { to: '/leads',          label: 'Discover', icon: 'search',   end: true },
  { to: '/leads/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { to: '/leads/schedule', label: 'Schedule', icon: 'calendar' },
]

const STORE_KEY = 'helix_leads_seller'

const selectStyle = {
  background: 'rgba(0,0,0,.28)', border: '1px solid var(--line-2)', borderRadius: 9,
  color: 'var(--fg)', padding: '.35rem .55rem', fontSize: '.82rem', outline: 'none', maxWidth: 320,
}

export function LeadsLayout() {
  const { companies, setCompanies } = useHelixStore()
  const [accountId, setAccountId] = useState('')
  const [picked, setPicked] = useState<string>(() => {
    try { return localStorage.getItem(STORE_KEY) ?? '' } catch { return '' }
  })

  // The account owner's identity. A passkey session carries it; the API-key
  // break-glass path has no session, so the seller falls back to a real company.
  useEffect(() => {
    let live = true
    ;(async () => {
      if (useHelixStore.getState().companies.length === 0) {
        try { const list = await api.listCompanies(); if (live) setCompanies(list) } catch { /* ignore */ }
      }
      try { const me = await auth.me(); if (live && me?.company) setAccountId(me.company) } catch { /* no session */ }
    })()
    return () => { live = false }
  }, [setCompanies])

  function setSellerId(id: string) {
    setPicked(id)
    try { id ? localStorage.setItem(STORE_KEY, id) : localStorage.removeItem(STORE_KEY) } catch { /* ignore */ }
  }

  const seller: LeadsSeller | null = useMemo(() => {
    // An explicit pick of one of your own businesses wins.
    if (picked && picked !== accountId) {
      const c = companies.find((x) => x.id === picked)
      if (c) return { id: c.id, name: c.name || c.id, isAccount: false }
    }
    // Default: the account itself.
    if (accountId) return { id: accountId, name: 'My account', isAccount: true }
    // Break-glass (no session): a real company, never a fabricated one.
    if (companies.length > 0) {
      const c = companies[0]
      return { id: c.id, name: c.name || c.id, isAccount: false }
    }
    return null
  }, [picked, accountId, companies])

  const selector = (
    <label className="sub" style={{ display: 'inline-flex', alignItems: 'center', gap: '.5rem' }}>
      Prospecting as
      <select style={selectStyle} value={seller?.id ?? ''} onChange={(e) => setSellerId(e.target.value)}>
        {accountId && <option value={accountId}>My account (owner prospecting)</option>}
        {companies.filter((c) => c.id !== accountId).map((c) => (
          <option key={c.id} value={c.id}>{c.name || c.id}</option>
        ))}
        {!accountId && companies.length === 0 && <option value="">— select —</option>}
      </select>
    </label>
  )

  return (
    <LeadsContext.Provider value={{ seller, companies, setSellerId, accountId }}>
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
    </LeadsContext.Provider>
  )
}
