import { authFetch } from '../api'
import { useEffect, useState } from 'react'
import { useHelixStore } from '../store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AssetType = 'card' | 'campaign_asset' | 'plan' | 'site' | 'jingle'

interface PortfolioAsset {
  id: string
  companyId: string
  type: AssetType
  name: string
  createdAt: string
  previewText?: string
  downloadUrl?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS: Array<{ label: string; filter: AssetType | 'all' }> = [
  { label: 'All',       filter: 'all' },
  { label: 'Cards',     filter: 'card' },
  { label: 'Campaigns', filter: 'campaign_asset' },
  { label: 'Plans',     filter: 'plan' },
  { label: 'Sites',     filter: 'site' },
  { label: 'Jingles',   filter: 'jingle' },
]

const TYPE_BADGE: Record<AssetType, { label: string; bg: string; color: string }> = {
  card:           { label: 'Card',     bg: '#6366f122', color: 'var(--brand)' },
  campaign_asset: { label: 'Campaign', bg: '#f59e0b22', color: 'var(--warn)' },
  plan:           { label: 'Plan',     bg: '#10b98122', color: 'var(--ok)' },
  site:           { label: 'Site',     bg: '#3b82f622', color: 'var(--info)' },
  jingle:         { label: 'Jingle',   bg: '#ec489922', color: '#f472b6' },
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PortfolioPage() {
  const { currentCompany } = useHelixStore()
  const [assets, setAssets]       = useState<PortfolioAsset[]>([])
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<AssetType | 'all'>('all')

  useEffect(() => {
    if (!currentCompany) return
    let live = true
    setLoading(true)
    setError(null)

    authFetch(`/portfolio/${currentCompany.id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<PortfolioAsset[]>
      })
      .then((data) => { if (live) setAssets(data) })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (live) setLoading(false) })

    return () => { live = false }
  }, [currentCompany])

  const filtered = activeTab === 'all'
    ? assets
    : assets.filter((a) => a.type === activeTab)

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '0.4rem 0.9rem',
    fontSize: '0.82rem',
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--brand)' : 'var(--fg-3)',
    background: active ? '#6366f122' : 'transparent',
    border: '1px solid',
    borderColor: active ? '#6366f155' : 'var(--line-2)',
    borderRadius: 6,
    cursor: 'pointer',
  })

  const cardStyle: React.CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--line-2)',
    borderRadius: 10,
    padding: '1rem 1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.4rem',
  }

  // ---------------------------------------------------------------------------
  // No company selected
  // ---------------------------------------------------------------------------

  if (!currentCompany) {
    return (
      <div style={{ color: 'var(--fg-3)', padding: '2rem', textAlign: 'center' }}>
        Select a company from the top bar to view its portfolio.
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--fg)', margin: 0 }}>
          Portfolio
        </h1>
        <p style={{ color: 'var(--fg-3)', fontSize: '0.875rem', marginTop: '0.35rem' }}>
          All assets produced for <strong style={{ color: 'var(--fg)' }}>{currentCompany.name}</strong>
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        {TABS.map(({ label, filter }) => (
          <button
            key={filter}
            style={tabStyle(activeTab === filter)}
            onClick={() => setActiveTab(filter)}
          >
            {label}
            {filter !== 'all' && (
              <span style={{ marginLeft: '0.35rem', opacity: 0.7 }}>
                ({assets.filter((a) => a.type === filter).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ color: 'var(--fg-2)', padding: '2rem', textAlign: 'center' }}>
          Loading portfolio…
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div style={{ color: 'var(--bad)', padding: '1rem' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div className="glass" style={{ background: 'var(--surface)', borderRadius: 12, padding: '3rem',
          textAlign: 'center', border: '2px dashed var(--line-2)',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: '0.4rem' }}>
            No {activeTab === 'all' ? 'assets' : activeTab.replace('_', ' ') + 's'} yet
          </div>
          <div style={{ color: 'var(--fg-3)', fontSize: '0.875rem' }}>
            {activeTab === 'card' && 'Onboard a business to generate a card.'}
            {activeTab === 'campaign_asset' && 'Run a campaign to generate assets.'}
            {activeTab === 'plan' && 'Generate a business plan from the company page.'}
            {activeTab === 'site' && 'Generate a landing page from the company page.'}
            {activeTab === 'jingle' && 'Generate a brand jingle from Voice Studio.'}
            {activeTab === 'all' && 'Generate content for this company to populate your portfolio.'}
          </div>
        </div>
      )}

      {/* Asset grid */}
      {!loading && !error && filtered.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1rem',
        }}>
          {filtered.map((asset) => {
            const badge = TYPE_BADGE[asset.type]
            return (
              <div key={asset.id} style={cardStyle}>
                {/* Badge + date row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{
                    fontSize: '0.7rem', fontWeight: 600,
                    padding: '0.15rem 0.5rem', borderRadius: 4,
                    background: badge.bg, color: badge.color,
                  }}>
                    {badge.label}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--fg-3)' }}>
                    {formatDate(asset.createdAt)}
                  </span>
                </div>

                {/* Name */}
                <div style={{ fontWeight: 600, color: 'var(--fg)', fontSize: '0.9rem' }}>
                  {asset.name}
                </div>

                {/* Preview text */}
                {asset.previewText && (
                  <div style={{
                    fontSize: '0.8rem', color: 'var(--fg-3)', lineHeight: 1.4,
                    overflow: 'hidden', display: '-webkit-box',
                    WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                  }}>
                    {asset.previewText}
                  </div>
                )}

                {/* Action button */}
                {asset.downloadUrl && (
                  <a
                    href={asset.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      marginTop: '0.4rem', alignSelf: 'flex-start',
                      fontSize: '0.78rem', fontWeight: 600,
                      color: 'var(--brand)', textDecoration: 'none',
                      padding: '0.3rem 0.75rem',
                      background: '#6366f122', borderRadius: 6,
                      border: '1px solid #6366f133',
                    }}
                  >
                    {asset.type === 'site' ? 'View Site' :
                     asset.type === 'plan' ? 'Export Plan' : 'Download'}
                  </a>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
