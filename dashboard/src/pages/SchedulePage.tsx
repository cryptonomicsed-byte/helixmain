import { useState, useEffect } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Channel = 'instagram' | 'tiktok' | 'linkedin' | 'email' | 'facebook' | 'x' | 'sms'

interface ScheduledAsset {
  assetId: string
  companyId: string
  publishAt: string
  scheduledAt: string
}

interface CampaignAsset {
  id: string
  channel: Channel
  assetType: string
  text: string
  status: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_COLORS: Record<string, string> = {
  instagram: '#e1306c',
  tiktok:    '#ff0050',
  linkedin:  '#0a66c2',
  email:     '#f59e0b',
  facebook:  '#1877f2',
  x:         '#94a3b8',
  sms:       '#10b981',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPublishAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month:   'short',
      day:     'numeric',
      hour:    'numeric',
      minute:  '2-digit',
      hour12:  true,
    })
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ChannelBadge({ channel }: { channel: string }) {
  const color = CHANNEL_COLORS[channel] ?? '#94a3b8'
  return (
    <span style={{
      background: color + '22',
      color,
      border: `1px solid ${color}44`,
      borderRadius: 4,
      padding: '0.15rem 0.5rem',
      fontSize: '0.72rem',
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.04em',
    }}>
      {channel}
    </span>
  )
}

function ScheduledRow({
  entry,
  asset,
  onCancel,
}: {
  entry: ScheduledAsset
  asset: CampaignAsset | undefined
  onCancel: (assetId: string) => void
}) {
  const [cancelling, setCancelling] = useState(false)

  async function handleCancel() {
    setCancelling(true)
    try {
      await api.cancelSchedule(entry.assetId)
      onCancel(entry.assetId)
    } catch {
      // best-effort
    } finally {
      setCancelling(false)
    }
  }

  const preview = asset?.text
    ? asset.text.length > 100 ? asset.text.slice(0, 100) + '…' : asset.text
    : entry.assetId

  return (
    <div style={{
      background: '#1e2433',
      border: '1px solid #2d3748',
      borderRadius: 10,
      padding: '1rem 1.25rem',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '1rem',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
          {asset && <ChannelBadge channel={asset.channel} />}
          {asset && (
            <span style={{
              background: '#2d3748', color: '#94a3b8',
              borderRadius: 4, padding: '0.15rem 0.5rem',
              fontSize: '0.72rem', fontWeight: 600,
              textTransform: 'uppercase' as const,
            }}>
              {asset.assetType}
            </span>
          )}
          <span style={{
            background: '#6366f122', color: '#818cf8',
            borderRadius: 4, padding: '0.15rem 0.5rem',
            fontSize: '0.72rem', fontWeight: 600,
          }}>
            {asset?.status ?? 'approved'}
          </span>
        </div>

        <div style={{ color: '#cbd5e1', fontSize: '0.83rem', marginBottom: '0.35rem' }}>
          {preview}
        </div>

        <div style={{ color: '#64748b', fontSize: '0.78rem' }}>
          Scheduled: {formatPublishAt(entry.publishAt)}
        </div>
      </div>

      <button
        onClick={handleCancel}
        disabled={cancelling}
        style={{
          background: cancelling ? '#374151' : '#7f1d1d',
          color: cancelling ? '#94a3b8' : '#fca5a5',
          border: '1px solid #991b1b',
          borderRadius: 6,
          padding: '0.4rem 0.85rem',
          fontSize: '0.8rem',
          fontWeight: 600,
          cursor: cancelling ? 'not-allowed' : 'pointer',
          flexShrink: 0,
        }}
      >
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function SchedulePage() {
  const { currentCompany } = useHelixStore()

  const [scheduled, setScheduled] = useState<ScheduledAsset[]>([])
  const [assetMap, setAssetMap] = useState<Map<string, CampaignAsset>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Schedule form state
  const [formAssetId, setFormAssetId] = useState('')
  const [formPublishAt, setFormPublishAt] = useState('')
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSuccess, setFormSuccess] = useState(false)

  useEffect(() => {
    if (!currentCompany) return
    let live = true
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await api.getScheduled(currentCompany!.id)
        if (!live) return
        setScheduled(res.scheduled)

        // Fetch asset details for each scheduled entry (best-effort)
        const assetIds = res.scheduled.map((s: ScheduledAsset) => s.assetId)
        const fetched = new Map<string, CampaignAsset>()
        await Promise.allSettled(
          assetIds.map(async (id: string) => {
            try {
              const a = await api.getAsset(id)
              fetched.set(id, a)
            } catch { /* skip */ }
          }),
        )
        if (live) setAssetMap(fetched)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (live) setLoading(false)
      }
    }
    load()
    return () => { live = false }
  }, [currentCompany])

  function handleCancelled(assetId: string) {
    setScheduled((prev) => prev.filter((s) => s.assetId !== assetId))
  }

  async function handleSchedule() {
    if (!formAssetId.trim()) { setFormError('Asset ID is required.'); return }
    if (!formPublishAt)      { setFormError('Publish time is required.'); return }
    if (!currentCompany)     { setFormError('Select a company first.'); return }

    setFormLoading(true)
    setFormError(null)
    setFormSuccess(false)
    try {
      const res = await api.scheduleAsset(
        formAssetId.trim(),
        currentCompany.id,
        new Date(formPublishAt).toISOString(),
      )
      setScheduled((prev) => [...prev, res.scheduled])
      setFormAssetId('')
      setFormPublishAt('')
      setFormSuccess(true)
      setTimeout(() => setFormSuccess(false), 3000)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setFormLoading(false)
    }
  }

  if (!currentCompany) {
    return (
      <div style={{ color: '#64748b', padding: '2rem', textAlign: 'center' }}>
        Select a company to manage its schedule.
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f1f5f9', margin: '0 0 0.35rem' }}>
        Social Schedule
      </h1>
      <p style={{ color: '#64748b', fontSize: '0.875rem', marginTop: 0, marginBottom: '1.5rem' }}>
        Manage scheduled posts for {currentCompany.name}.
      </p>

      {loading && (
        <div style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1rem' }}>
          Loading schedule…
        </div>
      )}
      {error && (
        <div style={{ color: '#ef4444', fontSize: '0.875rem', marginBottom: '1rem' }}>{error}</div>
      )}

      {/* Scheduled list */}
      {!loading && scheduled.length === 0 ? (
        <div style={{
          background: '#1e2433', borderRadius: 12, padding: '3rem',
          textAlign: 'center', border: '2px dashed #2d3748', marginBottom: '2rem',
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>📅</div>
          <div style={{ fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
            No scheduled posts
          </div>
          <div style={{ color: '#64748b', fontSize: '0.875rem' }}>
            Generate a campaign and approve assets to schedule them.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2rem' }}>
          {scheduled.map((entry) => (
            <ScheduledRow
              key={entry.assetId}
              entry={entry}
              asset={assetMap.get(entry.assetId)}
              onCancel={handleCancelled}
            />
          ))}
        </div>
      )}

      {/* Schedule Asset panel */}
      <div style={{
        background: '#1e2433',
        border: '1px solid #2d3748',
        borderRadius: 10,
        padding: '1.25rem',
      }}>
        <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0', margin: '0 0 1rem' }}>
          Schedule an Asset
        </h2>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', color: '#64748b', fontSize: '0.78rem', marginBottom: '0.3rem' }}>
              Asset ID
            </label>
            <input
              value={formAssetId}
              onChange={(e) => setFormAssetId(e.target.value)}
              placeholder="Paste asset ID…"
              style={{
                width: '100%', background: '#0f1117', border: '1px solid #2d3748',
                color: '#e2e8f0', borderRadius: 6, padding: '0.5rem 0.75rem',
                fontSize: '0.82rem', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', color: '#64748b', fontSize: '0.78rem', marginBottom: '0.3rem' }}>
              Publish Time
            </label>
            <input
              type="datetime-local"
              value={formPublishAt}
              onChange={(e) => setFormPublishAt(e.target.value)}
              style={{
                width: '100%', background: '#0f1117', border: '1px solid #2d3748',
                color: '#e2e8f0', borderRadius: 6, padding: '0.5rem 0.75rem',
                fontSize: '0.82rem', outline: 'none', boxSizing: 'border-box',
                colorScheme: 'dark',
              }}
            />
          </div>
          <button
            onClick={handleSchedule}
            disabled={formLoading}
            style={{
              background: formLoading ? '#374151' : '#6366f1',
              color: '#fff', border: 'none', borderRadius: 6,
              padding: '0.5rem 1.1rem', fontSize: '0.85rem', fontWeight: 600,
              cursor: formLoading ? 'not-allowed' : 'pointer',
              flexShrink: 0, alignSelf: 'flex-end',
            }}
          >
            {formLoading ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
        {formError && (
          <div style={{ color: '#ef4444', fontSize: '0.8rem', marginTop: '0.6rem' }}>{formError}</div>
        )}
        {formSuccess && (
          <div style={{ color: '#22c55e', fontSize: '0.8rem', marginTop: '0.6rem' }}>Asset scheduled successfully.</div>
        )}
      </div>
    </div>
  )
}
