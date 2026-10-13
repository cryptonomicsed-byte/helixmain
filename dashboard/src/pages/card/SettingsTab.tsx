import { Outlet, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { SubNav, type SubTab } from '../../components/SubNav'
import { api } from '../../api'

// One Settings section for the card, consolidating what were three separate
// tabs: AI (model routing / keys / budget), Approvals (the gatekeeper hold
// queue) and History (the card's hash-chained changelog). Nothing was dropped —
// each is now a sub-view here, and the Approvals tab carries a live count so a
// held action is visible without opening it.
export function SettingsTab() {
  const { id = '' } = useParams<{ id: string }>()
  const [pending, setPending] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    const poll = async () => {
      try {
        const d = await api.gkQueue()
        if (live) setPending((d.pending ?? []).filter((p) => !p.card_id || p.card_id === id).length)
      } catch { if (live) setPending(null) }
    }
    poll()
    const t = setInterval(poll, 5000)
    return () => { live = false; clearInterval(t) }
  }, [id])

  const tabs: SubTab[] = [
    { to: `/card/${id}/settings`,           label: 'AI',        icon: 'settings',  end: true },
    { to: `/card/${id}/settings/approvals`, label: 'Approvals', icon: 'approvals', badge: pending ?? undefined },
    { to: `/card/${id}/settings/history`,   label: 'History',   icon: 'clock' },
  ]

  return (
    <div>
      <div className="reveal" style={{ marginBottom: '1rem' }}>
        <div className="h1">Settings</div>
        <div className="sub" style={{ marginTop: 4 }}>
          AI routing and keys, approvals, and the card's change history — all in one place.
        </div>
      </div>

      <SubNav tabs={tabs} />

      <Outlet />
    </div>
  )
}
