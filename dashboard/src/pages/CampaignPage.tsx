import { useState } from 'react'
import { useHelixStore } from '../store'
import { api } from '../api'

// ---------------------------------------------------------------------------
// Types (mirroring backend contentPipeline shapes)
// ---------------------------------------------------------------------------

type Channel = 'instagram' | 'tiktok' | 'linkedin' | 'email' | 'facebook' | 'x'

interface ChannelStrategy {
  objective: string
  tone: string
  frequency: string
}

interface UserStory {
  id: string
  channel: Channel
  assetType: string
  brief: string
  audiencePersona?: string
}

interface CampaignPRD {
  id: string
  companyId: string
  goal: string
  channels: Channel[]
  overview: string
  channelStrategies: Record<string, ChannelStrategy>
  userStories: UserStory[]
  sequencingPlan: string
  createdAt: string
}

interface VoiceValidation {
  passed: boolean
  violations: string[]
}

interface CampaignAsset {
  id: string
  campaignId: string
  channel: Channel
  assetType: string
  text: string
  hashtags: string[]
  mediaDescription: string
  qualityScore: number
  status: string
  voiceValidation?: VoiceValidation
  audioSuggestion?: string
  emailMetadata?: { subject: string; preheader: string; cta: string }
  createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CHANNELS: { id: Channel; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok',   label: 'TikTok'    },
  { id: 'linkedin', label: 'LinkedIn'  },
  { id: 'email',    label: 'Email'     },
  { id: 'facebook', label: 'Facebook'  },
  { id: 'x',        label: 'X'         },
]

const CHANNEL_COLORS: Record<Channel, string> = {
  instagram: '#e1306c',
  tiktok:    '#ff0050',
  linkedin:  '#0a66c2',
  email:     'var(--warn)',
  facebook:  '#1877f2',
  x:         'var(--fg-2)',
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ChannelBadge({ channel }: { channel: Channel }) {
  const label = ALL_CHANNELS.find((c) => c.id === channel)?.label ?? channel
  return (
    <span style={{
      background: CHANNEL_COLORS[channel] + '22',
      color: CHANNEL_COLORS[channel],
      border: `1px solid ${CHANNEL_COLORS[channel]}44`,
      borderRadius: 4,
      padding: '0.15rem 0.5rem',
      fontSize: '0.72rem',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>
      {label}
    </span>
  )
}

function QualityBadge({ score }: { score: number }) {
  const color = score >= 80 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--bad)'
  return (
    <span style={{
      background: color + '22',
      color,
      border: `1px solid ${color}44`,
      borderRadius: 4,
      padding: '0.15rem 0.5rem',
      fontSize: '0.72rem',
      fontWeight: 700,
    }}>
      {score}/100
    </span>
  )
}

function AssetCard({
  asset,
  companyId,
  onApproved,
}: {
  asset: CampaignAsset
  companyId: string
  onApproved: (assetId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  async function handleApprove() {
    setApproving(true)
    setApproveError(null)
    try {
      await api.contentApprove(asset.id, companyId)
      onApproved(asset.id)
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : String(e))
    } finally {
      setApproving(false)
    }
  }

  const displayText = asset.assetType === 'email' && asset.emailMetadata
    ? `Subject: ${asset.emailMetadata.subject}\nPreheader: ${asset.emailMetadata.preheader}\nCTA: ${asset.emailMetadata.cta}`
    : asset.text

  return (
    <div className="glass" style={{ background: 'var(--surface)',
      border: '1px solid var(--line-2)',
      borderRadius: 10,
      padding: '1rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.6rem',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <ChannelBadge channel={asset.channel} />
        <span style={{
          background: 'var(--line-2)', color: 'var(--fg-2)',
          borderRadius: 4, padding: '0.15rem 0.5rem',
          fontSize: '0.72rem', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.04em',
        }}>
          {asset.assetType}
        </span>
        <QualityBadge score={asset.qualityScore} />
        {asset.voiceValidation && (
          <span style={{
            fontSize: '0.72rem', fontWeight: 600,
            color: asset.voiceValidation.passed ? 'var(--ok)' : 'var(--bad)',
          }}>
            {asset.voiceValidation.passed ? '✓ voice' : '✗ voice'}
          </span>
        )}
      </div>

      {/* Text content */}
      <div
        onClick={() => setExpanded((x) => !x)}
        style={{
          color: 'var(--fg)',
          fontSize: '0.83rem',
          lineHeight: 1.55,
          cursor: 'pointer',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: expanded ? undefined : 3,
          WebkitBoxOrient: 'vertical',
          whiteSpace: 'pre-wrap',
        }}
      >
        {displayText}
      </div>
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          style={{ background: 'none', border: 'none', color: 'var(--brand)', fontSize: '0.78rem', cursor: 'pointer', textAlign: 'left', padding: 0 }}
        >
          Show more
        </button>
      )}

      {/* TikTok audio suggestion */}
      {asset.audioSuggestion && (
        <div style={{ fontSize: '0.78rem', color: 'var(--fg-2)', fontStyle: 'italic' }}>
          Audio: {asset.audioSuggestion}
        </div>
      )}

      {/* Hashtags */}
      {asset.hashtags.length > 0 && (
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
          {asset.hashtags.slice(0, 6).map((tag) => (
            <span key={tag} style={{ color: 'var(--brand)', fontSize: '0.75rem' }}>{tag}</span>
          ))}
        </div>
      )}

      {/* Approve button */}
      {asset.status !== 'approved' && asset.status !== 'published' && (
        <button
          onClick={handleApprove}
          disabled={approving}
          style={{
            background: approving ? 'var(--line-2)' : 'var(--brand-2)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '0.45rem 0.9rem',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: approving ? 'not-allowed' : 'pointer',
            alignSelf: 'flex-start',
            marginTop: '0.25rem',
          }}
        >
          {approving ? 'Queuing…' : 'Approve & Queue'}
        </button>
      )}
      {asset.status === 'approved' && (
        <span style={{ color: 'var(--ok)', fontSize: '0.8rem', fontWeight: 600 }}>Queued for approval</span>
      )}
      {approveError && (
        <div style={{ color: 'var(--bad)', fontSize: '0.78rem' }}>{approveError}</div>
      )}
    </div>
  )
}

function UserStoryAccordion({ stories }: { stories: UserStory[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ border: '1px solid var(--line-2)', borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen((x) => !x)}
        style={{
          width: '100%', background: 'var(--surface)', border: 'none',
          color: 'var(--fg)', padding: '0.75rem 1rem',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600,
        }}
      >
        <span>User Stories ({stories.length})</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {stories.map((s) => (
            <div key={s.id} style={{ fontSize: '0.83rem', color: 'var(--fg-2)', borderLeft: '2px solid var(--brand-2)', paddingLeft: '0.75rem' }}>
              <span style={{ color: CHANNEL_COLORS[s.channel], fontWeight: 600 }}>{s.channel}</span>
              {' / '}{s.assetType} — {s.brief}
              {s.audiencePersona && <span style={{ color: 'var(--fg-3)' }}> (for: {s.audiencePersona})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function CampaignPage() {
  const { currentCompany, currentCard } = useHelixStore()

  const [goal, setGoal] = useState('')
  const [selectedChannels, setSelectedChannels] = useState<Set<Channel>>(new Set())
  const [prd, setPrd] = useState<CampaignPRD | null>(null)
  const [assets, setAssets] = useState<CampaignAsset[]>([])
  const [assetMap, setAssetMap] = useState<Map<string, CampaignAsset>>(new Map())

  const [prdLoading, setPrdLoading] = useState(false)
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [prdError, setPrdError] = useState<string | null>(null)
  const [assetsError, setAssetsError] = useState<string | null>(null)

  function toggleChannel(ch: Channel) {
    setSelectedChannels((prev) => {
      const next = new Set(prev)
      if (next.has(ch)) next.delete(ch); else next.add(ch)
      return next
    })
  }

  async function handleGeneratePRD() {
    if (!currentCompany) { setPrdError('Select a company first.'); return }
    if (!goal.trim())    { setPrdError('Enter a campaign goal.'); return }
    if (selectedChannels.size === 0) { setPrdError('Select at least one channel.'); return }

    const cardId = currentCard?.id ?? currentCompany.id

    setPrdLoading(true)
    setPrdError(null)
    setPrd(null)
    setAssets([])

    try {
      const res = await api.contentPrd(
        currentCompany.id,
        cardId,
        goal,
        Array.from(selectedChannels),
      )
      setPrd(res.prd)
    } catch (e) {
      setPrdError(e instanceof Error ? e.message : String(e))
    } finally {
      setPrdLoading(false)
    }
  }

  async function handleGenerateAssets() {
    if (!prd || !currentCompany) return
    const cardId = currentCard?.id ?? currentCompany.id

    setAssetsLoading(true)
    setAssetsError(null)

    try {
      const res = await api.contentGenerate(currentCompany.id, cardId, prd)
      setAssets(res.assets)
      const m = new Map<string, CampaignAsset>()
      for (const a of res.assets) m.set(a.id, a)
      setAssetMap(m)
    } catch (e) {
      setAssetsError(e instanceof Error ? e.message : String(e))
    } finally {
      setAssetsLoading(false)
    }
  }

  function handleApproved(assetId: string) {
    setAssets((prev) =>
      prev.map((a) => a.id === assetId ? { ...a, status: 'approved' } : a),
    )
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--fg)', margin: '0 0 0.35rem' }}>
        Campaign Forge
      </h1>
      <p style={{ color: 'var(--fg-3)', fontSize: '0.875rem', marginTop: 0, marginBottom: '1.5rem' }}>
        Generate a full campaign PRD and social assets from your brand DNA.
      </p>

      {/* Goal input */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{ display: 'block', color: 'var(--fg-2)', fontSize: '0.82rem', marginBottom: '0.4rem' }}>
          Campaign Goal
        </label>
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Get more customers this weekend"
          style={{
            width: '100%', background: 'var(--surface)', border: '1px solid var(--line-2)',
            color: 'var(--fg)', borderRadius: 8, padding: '0.6rem 0.9rem',
            fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Channel selector */}
      <div style={{ marginBottom: '1.25rem' }}>
        <label style={{ display: 'block', color: 'var(--fg-2)', fontSize: '0.82rem', marginBottom: '0.5rem' }}>
          Channels
        </label>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {ALL_CHANNELS.map(({ id, label }) => {
            const active = selectedChannels.has(id)
            return (
              <button
                key={id}
                onClick={() => toggleChannel(id)}
                style={{
                  background: active ? CHANNEL_COLORS[id] + '33' : 'var(--surface)',
                  color: active ? CHANNEL_COLORS[id] : 'var(--fg-2)',
                  border: `1px solid ${active ? CHANNEL_COLORS[id] : 'var(--line-2)'}`,
                  borderRadius: 6,
                  padding: '0.4rem 0.85rem',
                  fontSize: '0.82rem',
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all 0.12s',
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Generate PRD button */}
      <button
        onClick={handleGeneratePRD}
        disabled={prdLoading}
        style={{
          background: prdLoading ? 'var(--line-2)' : 'var(--brand-2)',
          color: '#fff', border: 'none', borderRadius: 8,
          padding: '0.6rem 1.4rem', fontSize: '0.9rem', fontWeight: 600,
          cursor: prdLoading ? 'not-allowed' : 'pointer', marginBottom: '1rem',
        }}
      >
        {prdLoading ? 'Generating PRD…' : 'Generate Campaign PRD'}
      </button>

      {prdError && (
        <div style={{ color: 'var(--bad)', fontSize: '0.85rem', marginBottom: '1rem' }}>{prdError}</div>
      )}

      {/* PRD Preview */}
      {prd && (
        <div style={{ marginBottom: '1.5rem' }}>
          <div className="glass" style={{ background: 'var(--surface)', border: '1px solid var(--line-2)',
            borderRadius: 10, padding: '1.25rem', marginBottom: '1rem',
          }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--brand)', margin: '0 0 0.6rem' }}>
              Campaign Overview
            </h2>
            <p style={{ color: 'var(--fg)', fontSize: '0.875rem', lineHeight: 1.6, margin: 0 }}>
              {prd.overview}
            </p>
          </div>

          {/* Channel strategy cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '0.75rem',
            marginBottom: '1rem',
          }}>
            {prd.channels.map((ch) => {
              const s = prd.channelStrategies[ch]
              if (!s) return null
              return (
                <div key={ch} style={{
                  background: 'var(--surface)', border: `1px solid ${CHANNEL_COLORS[ch as Channel] ?? 'var(--line-2)'}33`,
                  borderRadius: 8, padding: '0.9rem',
                }}>
                  <ChannelBadge channel={ch as Channel} />
                  <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--fg-2)', lineHeight: 1.5 }}>
                    <div><span style={{ color: 'var(--fg-3)' }}>Objective:</span> {s.objective}</div>
                    <div><span style={{ color: 'var(--fg-3)' }}>Frequency:</span> {s.frequency}</div>
                  </div>
                </div>
              )
            })}
          </div>

          <UserStoryAccordion stories={prd.userStories} />

          {/* Generate Assets button */}
          <button
            onClick={handleGenerateAssets}
            disabled={assetsLoading}
            style={{
              background: assetsLoading ? 'var(--line-2)' : 'var(--ok)',
              color: '#fff', border: 'none', borderRadius: 8,
              padding: '0.6rem 1.4rem', fontSize: '0.9rem', fontWeight: 600,
              cursor: assetsLoading ? 'not-allowed' : 'pointer', marginTop: '1rem',
            }}
          >
            {assetsLoading ? 'Generating Assets…' : 'Generate Assets'}
          </button>

          {assetsError && (
            <div style={{ color: 'var(--bad)', fontSize: '0.85rem', marginTop: '0.5rem' }}>{assetsError}</div>
          )}
        </div>
      )}

      {/* Assets grid */}
      {assets.length > 0 && (
        <div>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--fg)', margin: '0 0 0.75rem' }}>
            Generated Assets ({assets.length})
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: '0.85rem',
          }}>
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={assetMap.get(asset.id) ?? asset}
                companyId={currentCompany?.id ?? ''}
                onApproved={handleApproved}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
