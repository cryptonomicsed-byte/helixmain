import { useEffect, useState, useCallback } from 'react'
import { useHelixStore } from '../store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MeteringAccount {
  balance: number
  tier: 'free' | 'pro' | 'agency'
  usageLog: UsageEntry[]
}

interface UsageEntry {
  id: string
  timestamp: string
  operationType: string
  creditsDeducted: number
  costUsd: number
  refunded: boolean
  refundReason?: string
}

interface TierInfo {
  name: string
  price: string
  credits: number
  priceId: string
}

interface PackInfo {
  name: string
  price: string
  credits: number
  priceId: string
}

interface BillingConfig {
  tiers: Record<string, TierInfo>
  packs: PackInfo[]
}

interface AffiliateAccount {
  companyId: string
  referralCode: string
  referredBy?: string
  referrals: string[]
  totalEarned: number
  createdAt: string
}

interface AffiliateStats {
  ok: boolean
  account: AffiliateAccount | null
  events: Array<{
    id: string
    referrerCompanyId: string
    referredCompanyId: string
    triggeredBy: string
    creditsAwarded: number
    timestamp: string
  }>
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const card: React.CSSProperties = {
  background: 'var(--surface)',
  borderRadius: 10,
  border: '1px solid var(--line-2)',
  padding: '1.25rem',
}

const sectionTitle: React.CSSProperties = {
  fontSize: '1rem',
  fontWeight: 700,
  color: 'var(--fg)',
  marginBottom: '1rem',
  marginTop: 0,
}

const label: React.CSSProperties = {
  fontSize: '0.72rem',
  color: 'var(--fg-3)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
}

const bigNumber: React.CSSProperties = {
  fontSize: '2.5rem',
  fontWeight: 800,
  color: 'var(--fg)',
  lineHeight: 1,
}

const tierBadge = (tier: string): React.CSSProperties => {
  const colors: Record<string, string> = {
    free: 'var(--fg-3)',
    pro: 'var(--brand-2)',
    agency: 'var(--warn)',
  }
  const c = colors[tier] ?? 'var(--fg-3)'
  return {
    display: 'inline-block',
    padding: '0.2rem 0.6rem',
    borderRadius: 4,
    background: c + '22',
    color: c,
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
  }
}

const btn = (variant: 'primary' | 'secondary' | 'outline'): React.CSSProperties => {
  if (variant === 'primary') return {
    background: 'var(--brand-2)', color: '#fff', border: 'none',
    borderRadius: 7, padding: '0.5rem 1.1rem', fontSize: '0.82rem',
    fontWeight: 600, cursor: 'pointer',
  }
  if (variant === 'secondary') return {
    background: 'var(--line-2)', color: 'var(--fg)', border: 'none',
    borderRadius: 7, padding: '0.5rem 1.1rem', fontSize: '0.82rem',
    fontWeight: 600, cursor: 'pointer',
  }
  return {
    background: 'transparent', color: 'var(--brand)',
    border: '1px solid var(--brand-2)',
    borderRadius: 7, padding: '0.5rem 1.1rem', fontSize: '0.82rem',
    fontWeight: 600, cursor: 'pointer',
  }
}

const TIER_ORDER: Array<'free' | 'pro' | 'agency'> = ['free', 'pro', 'agency']

const MONTHLY_LIMITS: Record<string, number> = {
  free: 100,
  pro: 1000,
  agency: 10000,
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BillingPage() {
  const { currentCompany } = useHelixStore()

  const [metering, setMetering]       = useState<MeteringAccount | null>(null)
  const [config, setConfig]           = useState<BillingConfig | null>(null)
  const [affiliate, setAffiliate]     = useState<AffiliateStats | null>(null)
  const [historyPage, setHistoryPage] = useState(0)
  const [loading, setLoading]         = useState(false)
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null)
  const [copied, setCopied]           = useState(false)
  const [error, setError]             = useState<string | null>(null)

  const companyId = currentCompany?.id ?? null

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    try {
      const [mRes, cRes, aRes] = await Promise.allSettled([
        fetch(`/api/metering/${companyId}`).then((r) => r.json()) as Promise<MeteringAccount>,
        fetch('/api/billing/config').then((r) => r.json()) as Promise<BillingConfig>,
        fetch(`/api/affiliate/${companyId}`).then((r) => r.json()) as Promise<AffiliateStats>,
      ])
      if (mRes.status === 'fulfilled') setMetering(mRes.value)
      if (cRes.status === 'fulfilled') setConfig(cRes.value)
      if (aRes.status === 'fulfilled') setAffiliate(aRes.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { load() }, [load])

  // Reset history page when company changes
  useEffect(() => { setHistoryPage(0) }, [companyId])

  async function handleCheckout(priceId: string) {
    if (!companyId) return
    setCheckoutLoading(priceId)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, priceId }),
      })
      const data = await res.json() as { ok: boolean; checkoutUrl?: string; mockUrl?: string; error?: string }
      if (data.ok && data.checkoutUrl) {
        window.location.href = data.checkoutUrl
      } else if (data.mockUrl) {
        window.open(data.mockUrl, '_blank')
      } else {
        setError(data.error ?? 'Checkout failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCheckoutLoading(null)
    }
  }

  async function handleInitAffiliate() {
    if (!companyId) return
    try {
      await fetch(`/api/affiliate/init/${companyId}`, { method: 'POST' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function handleCopyReferral(code: string) {
    const link = `https://helixmain.duckdns.org/?ref=${code}`
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (!companyId) {
    return (
      <div style={{ color: 'var(--fg-2)', padding: '2rem', textAlign: 'center' }}>
        Select a company from the top bar to manage billing.
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{ color: 'var(--fg-2)', padding: '2rem', textAlign: 'center' }}>
        Loading billing data…
      </div>
    )
  }

  // History pagination
  const PAGE_SIZE = 20
  const historyEntries = metering
    ? [...metering.usageLog].reverse().slice(historyPage * PAGE_SIZE, (historyPage + 1) * PAGE_SIZE)
    : []
  const totalPages = metering ? Math.ceil(metering.usageLog.length / PAGE_SIZE) : 0

  // Credits used this period
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const usedThisMonth = metering
    ? metering.usageLog
        .filter((e) => !e.refunded && e.creditsDeducted > 0 && new Date(e.timestamp) >= monthStart)
        .reduce((sum, e) => sum + e.creditsDeducted, 0)
    : 0
  const monthlyLimit = MONTHLY_LIMITS[metering?.tier ?? 'free']
  const progressPct  = Math.min(100, Math.round((usedThisMonth / monthlyLimit) * 100))

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ marginBottom: '1.75rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--fg)', margin: 0 }}>
          Billing &amp; Credits
        </h1>
        <p style={{ color: 'var(--fg-3)', fontSize: '0.875rem', marginTop: '0.35rem' }}>
          Manage your plan, top up credits, and track usage.
        </p>
      </div>

      {error && (
        <div style={{
          background: '#7f1d1d22', border: '1px solid #ef444444', borderRadius: 8,
          color: 'var(--bad)', padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.85rem',
        }}>
          {error}
        </div>
      )}

      {/* ── Section 1: Current Plan ─────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: '1.5rem' }}>
        <h2 style={sectionTitle}>Current Plan</h2>
        <div style={{ display: 'flex', gap: '2.5rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <div style={label}>Credits Remaining</div>
            <div style={{ ...bigNumber, marginTop: '0.3rem' }}>
              {metering ? metering.balance.toLocaleString() : '—'}
            </div>
          </div>
          <div>
            <div style={label}>Plan</div>
            <div style={{ marginTop: '0.5rem' }}>
              <span style={tierBadge(metering?.tier ?? 'free')}>
                {metering?.tier ?? 'free'}
              </span>
            </div>
          </div>
          <div>
            <div style={label}>Monthly Allowance</div>
            <div style={{ color: 'var(--fg)', fontSize: '1.1rem', fontWeight: 600, marginTop: '0.4rem' }}>
              {monthlyLimit.toLocaleString()} credits / mo
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ marginTop: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
            <span style={label}>Used This Period</span>
            <span style={{ fontSize: '0.78rem', color: 'var(--fg-2)' }}>
              {usedThisMonth.toLocaleString()} / {monthlyLimit.toLocaleString()} ({progressPct}%)
            </span>
          </div>
          <div style={{
            background: 'var(--line-2)', borderRadius: 99, height: 8, overflow: 'hidden',
          }}>
            <div style={{
              background: progressPct > 85 ? 'var(--bad)' : 'var(--brand-2)',
              height: '100%',
              width: `${progressPct}%`,
              borderRadius: 99,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      </div>

      {/* ── Section 2: Upgrade Plan ─────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: '1.5rem' }}>
        <h2 style={sectionTitle}>Upgrade Plan</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
          {TIER_ORDER.map((tierKey) => {
            const tier      = config?.tiers[tierKey]
            const isCurrent = metering?.tier === tierKey
            return (
              <div key={tierKey} style={{
                background: isCurrent ? '#6366f111' : 'var(--bg-2)',
                border: isCurrent ? '1.5px solid var(--brand-2)' : '1px solid var(--line-2)',
                borderRadius: 10,
                padding: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                position: 'relative',
              }}>
                {isCurrent && (
                  <span style={{
                    position: 'absolute', top: '0.75rem', right: '0.75rem',
                    fontSize: '0.7rem', color: 'var(--brand)', fontWeight: 700,
                  }}>
                    ✓ Current
                  </span>
                )}
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--fg)' }}>
                  {tier?.name ?? tierKey}
                </div>
                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--brand)' }}>
                  {tier?.price ?? '—'}
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--fg-2)' }}>
                  {tier ? tier.credits.toLocaleString() : '—'} credits / mo
                </div>
                <button
                  style={{
                    ...btn(isCurrent ? 'secondary' : 'primary'),
                    marginTop: '0.5rem',
                    opacity: isCurrent ? 0.5 : 1,
                  }}
                  disabled={isCurrent || !tier || checkoutLoading !== null}
                  onClick={() => tier && handleCheckout(tier.priceId)}
                >
                  {checkoutLoading === tier?.priceId
                    ? 'Redirecting…'
                    : isCurrent
                    ? 'Current Plan'
                    : 'Upgrade'}
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Section 3: Credit Packs ─────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: '1.5rem' }}>
        <h2 style={sectionTitle}>Credit Packs</h2>
        <p style={{ fontSize: '0.82rem', color: 'var(--fg-3)', marginTop: 0, marginBottom: '1rem' }}>
          One-time top-ups — credits never expire.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '1rem' }}>
          {(config?.packs ?? []).map((pack) => (
            <div key={pack.priceId} style={{
              background: 'var(--bg-2)', border: '1px solid var(--line-2)',
              borderRadius: 10, padding: '1.1rem',
              display: 'flex', flexDirection: 'column', gap: '0.4rem',
            }}>
              <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--fg)' }}>
                {pack.name}
              </div>
              <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--ok)' }}>
                {pack.price}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--fg-2)' }}>
                {pack.credits.toLocaleString()} credits
              </div>
              <button
                style={{ ...btn('outline'), marginTop: '0.4rem' }}
                disabled={checkoutLoading !== null}
                onClick={() => handleCheckout(pack.priceId)}
              >
                {checkoutLoading === pack.priceId ? 'Redirecting…' : 'Buy'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Section 4: Usage History ────────────────────────────────────── */}
      <div style={{ ...card, marginBottom: '1.5rem' }}>
        <h2 style={sectionTitle}>Usage History</h2>
        {historyEntries.length === 0 ? (
          <div style={{ color: 'var(--fg-3)', fontSize: '0.85rem', padding: '1rem 0' }}>
            No usage recorded yet.
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr>
                    {['Timestamp', 'Operation', 'Credits', 'Balance After', 'Refunded'].map((h) => (
                      <th key={h} style={{
                        textAlign: 'left', padding: '0.5rem 0.75rem',
                        color: 'var(--fg-3)', fontWeight: 600, fontSize: '0.72rem',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                        borderBottom: '1px solid var(--line-2)',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {historyEntries.map((entry, i) => {
                    // Compute running balance-after by re-walking forward from current balance
                    // We just show the operation sign instead to avoid complexity
                    const isCredit = entry.creditsDeducted < 0
                    return (
                      <tr key={entry.id} style={{
                        background: i % 2 === 0 ? 'transparent' : '#13172a44',
                      }}>
                        <td style={{ padding: '0.5rem 0.75rem', color: 'var(--fg-2)' }}>
                          {new Date(entry.timestamp).toLocaleString()}
                        </td>
                        <td style={{ padding: '0.5rem 0.75rem', color: 'var(--fg)' }}>
                          {entry.operationType}
                        </td>
                        <td style={{
                          padding: '0.5rem 0.75rem',
                          color: isCredit ? 'var(--ok)' : 'var(--bad)',
                          fontWeight: 600,
                        }}>
                          {isCredit ? '+' : '-'}{Math.abs(entry.creditsDeducted)}
                        </td>
                        <td style={{ padding: '0.5rem 0.75rem', color: 'var(--fg-2)' }}>
                          —
                        </td>
                        <td style={{ padding: '0.5rem 0.75rem' }}>
                          {entry.refunded
                            ? <span style={{ color: 'var(--warn)', fontSize: '0.75rem' }}>Refunded</span>
                            : <span style={{ color: 'var(--fg-3)', fontSize: '0.75rem' }}>No</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'center' }}>
                <button
                  style={{ ...btn('secondary'), padding: '0.35rem 0.75rem' }}
                  disabled={historyPage === 0}
                  onClick={() => setHistoryPage((p) => p - 1)}
                >
                  ← Prev
                </button>
                <span style={{ color: 'var(--fg-3)', fontSize: '0.8rem' }}>
                  Page {historyPage + 1} / {totalPages}
                </span>
                <button
                  style={{ ...btn('secondary'), padding: '0.35rem 0.75rem' }}
                  disabled={historyPage >= totalPages - 1}
                  onClick={() => setHistoryPage((p) => p + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Section 5: Referral Program ─────────────────────────────────── */}
      <div style={{ ...card, marginBottom: '1.5rem' }}>
        <h2 style={sectionTitle}>Referral Program</h2>
        <p style={{ fontSize: '0.82rem', color: 'var(--fg-3)', marginTop: 0, marginBottom: '1.25rem' }}>
          Earn credits when you refer others. Commission: 10% (Starter) · 15% (Pro) · 20% (Agency).
        </p>

        {!affiliate?.account ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ color: 'var(--fg-2)', fontSize: '0.85rem' }}>
              You don't have a referral account yet.
            </div>
            <button style={btn('primary')} onClick={handleInitAffiliate}>
              Start Earning
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Referral code + copy */}
            <div>
              <div style={{ ...label, marginBottom: '0.5rem' }}>Your Referral Code</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <span style={{
                  background: 'var(--bg-2)', border: '1px solid var(--line-2)',
                  borderRadius: 7, padding: '0.5rem 1rem',
                  fontFamily: 'monospace', fontSize: '1rem',
                  color: 'var(--brand)', fontWeight: 700, letterSpacing: '0.1em',
                }}>
                  {affiliate.account.referralCode}
                </span>
                <button
                  style={btn('outline')}
                  onClick={() => handleCopyReferral(affiliate.account!.referralCode)}
                >
                  {copied ? 'Copied!' : 'Copy Link'}
                </button>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--fg-3)', marginTop: '0.5rem' }}>
                Share: https://helixmain.duckdns.org/?ref={affiliate.account.referralCode}
              </div>
            </div>

            {/* Stats row */}
            <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
              <div>
                <div style={label}>Referrals</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--fg)', marginTop: '0.2rem' }}>
                  {affiliate.account.referrals.length}
                </div>
              </div>
              <div>
                <div style={label}>Total Credits Earned</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--ok)', marginTop: '0.2rem' }}>
                  +{affiliate.account.totalEarned.toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
