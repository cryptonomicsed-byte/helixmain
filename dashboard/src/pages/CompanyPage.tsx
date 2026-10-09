import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useHelixStore } from '../store'
import { HealthBadge } from '../components/HealthBadge'
import { ChangelogViewer } from '../components/ChangelogViewer'
import { SpecialsEditor } from '../components/SpecialsEditor'
import { SocialEditor } from '../components/SocialEditor'
import type { BusinessCard, HealthResult, Changelog, GreetingResult, Voice, Special, Socials } from '../api'

type Tab = 'overview' | 'editor' | 'changelog' | 'health' | 'greeting'

const TAB_LABELS: { id: Tab; label: string }[] = [
  { id: 'overview',   label: 'Overview' },
  { id: 'editor',     label: 'Card Editor' },
  { id: 'changelog',  label: 'Changelog' },
  { id: 'health',     label: 'Health' },
  { id: 'greeting',   label: 'Greeting' },
]

const inputStyle: React.CSSProperties = {
  background: '#0f1117', border: '1px solid #2d3748', borderRadius: 6,
  color: '#e2e8f0', padding: '0.45rem 0.7rem', fontSize: '0.85rem', width: '100%',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.72rem', color: '#94a3b8', marginBottom: '0.2rem', display: 'block', fontWeight: 500,
}

function ConfidencePill({ inferred, confidence }: { inferred: boolean; confidence: number }) {
  if (!inferred) return <span style={{ fontSize: '0.65rem', color: '#22c55e', background: '#22c55e18', borderRadius: 3, padding: '0.08rem 0.3rem' }}>confirmed</span>
  return <span style={{ fontSize: '0.65rem', color: '#f59e0b', background: '#f59e0b18', borderRadius: 3, padding: '0.08rem 0.3rem' }}>inferred {Math.round(confidence * 100)}%</span>
}

function EditableField({ label, value, inferred, confidence, onChange }: {
  label: string; value: string; inferred: boolean; confidence: number; onChange: (v: string) => void
}) {
  return (
    <div style={{ marginBottom: '0.8rem' }}>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.2rem' }}>
        <label style={{ ...labelStyle, margin: 0 }}>{label}</label>
        <ConfidencePill inferred={inferred} confidence={confidence} />
      </div>
      <input style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

export function CompanyPage() {
  const { id } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = (searchParams.get('tab') as Tab) || 'overview'
  const setTab = (t: Tab) => setSearchParams({ tab: t })

  const { setCurrentCompany } = useHelixStore()

  const [card, setCard]           = useState<BusinessCard | null>(null)
  const [health, setHealth]       = useState<HealthResult | null>(null)
  const [changelog, setChangelog] = useState<Changelog | null>(null)
  const [greeting, setGreeting]   = useState<GreetingResult | null>(null)
  const [voices, setVoices]       = useState<Voice[]>([])
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [saveMsg, setSaveMsg]     = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)

  // Local card edits
  const [edits, setEdits] = useState<Partial<Record<string, string>>>({})
  const [specials, setSpecials]   = useState<Special[]>([])
  const [socials, setSocials]     = useState<Socials>({})

  useEffect(() => {
    if (!id) return
    let live = true
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const c = await api.getCard(id!)
        if (!live) return
        setCard(c)
        setSpecials(c.specials ?? [])
        setSocials(c.socials ?? {})
        setCurrentCompany({ id: id!, name: c.name?.value ?? id!, cardVersion: c.version, lastUpdated: c.updated_at ?? '' })

        // Load secondary data best-effort in parallel
        const [h, cl, vl] = await Promise.allSettled([
          api.health(id!),
          api.changelog(id!),
          api.voices(),
        ])
        if (!live) return
        if (h.status === 'fulfilled') setHealth(h.value)
        if (cl.status === 'fulfilled') setChangelog(cl.value)
        if (vl.status === 'fulfilled') setVoices(vl.value)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (live) setLoading(false)
      }
    }
    load()
    return () => { live = false }
  }, [id, setCurrentCompany])

  function fieldVal(key: keyof BusinessCard): string {
    if (key in edits) return edits[key as string] ?? ''
    const f = card?.[key] as { value?: string | null } | undefined
    return f?.value ?? ''
  }

  function fieldMeta(key: keyof BusinessCard) {
    const f = card?.[key] as { inferred?: boolean; confidence?: number } | undefined
    return { inferred: f?.inferred ?? false, confidence: f?.confidence ?? 1 }
  }

  function setField(key: string, val: string) {
    setEdits((p) => ({ ...p, [key]: val }))
  }

  async function handleSave() {
    if (!card) return
    setSaving(true)
    setSaveMsg(null)
    try {
      await api.compile(card.id, card.org_id)
      setSaveMsg('Saved & compiled successfully.')
    } catch (e) {
      setSaveMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSaving(false)
    }
  }

  async function loadGreeting() {
    if (!card) return
    try {
      const g = await api.greeting(card.id, card.org_id)
      setGreeting(g)
    } catch (e) {
      console.error('greeting failed', e)
    }
  }

  if (loading) return <div style={{ color: '#94a3b8', padding: '2rem' }}>Loading company…</div>
  if (error)   return <div style={{ color: '#ef4444', padding: '2rem' }}>Error: {error}</div>
  if (!card)   return <div style={{ color: '#64748b', padding: '2rem' }}>Company not found.</div>

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      {/* Page header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>
          {fieldVal('name') || id}
        </h1>
        <div style={{ color: '#64748b', fontSize: '0.8rem', marginTop: '0.2rem' }}>
          v{card.version} · {id}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '0.25rem', borderBottom: '1px solid #2d3748', marginBottom: '1.5rem' }}>
        {TAB_LABELS.map(({ id: tid, label }) => (
          <button key={tid} onClick={() => setTab(tid)} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '0.5rem 1rem', fontSize: '0.85rem', fontWeight: activeTab === tid ? 600 : 400,
            color: activeTab === tid ? '#818cf8' : '#64748b',
            borderBottom: activeTab === tid ? '2px solid #6366f1' : '2px solid transparent',
            transition: 'color 0.12s',
          }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW ── */}
      {activeTab === 'overview' && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {(
            [
              ['Business Name', 'name'],
              ['Tagline', 'tagline'],
              ['Phone', 'phone'],
              ['Address', 'address'],
              ['Website', 'website'],
              ['Hours', 'hours'],
            ] as [string, keyof BusinessCard][]
          ).map(([lbl, key]) => {
            const val = fieldVal(key)
            if (!val) return null
            return (
              <div key={key} style={{ display: 'flex', gap: '0.75rem', padding: '0.6rem 0', borderBottom: '1px solid #1e2433' }}>
                <span style={{ width: 120, fontSize: '0.8rem', color: '#64748b', flexShrink: 0 }}>{lbl}</span>
                <span style={{ fontSize: '0.9rem', color: '#e2e8f0' }}>{val}</span>
              </div>
            )
          })}

          {card.offerings?.items?.length ? (
            <div style={{ padding: '0.6rem 0', borderBottom: '1px solid #1e2433' }}>
              <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '0.4rem' }}>Offerings</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {card.offerings.items.map((o) => (
                  <span key={o} style={{ background: '#6366f122', color: '#818cf8', borderRadius: 5, padding: '0.2rem 0.6rem', fontSize: '0.78rem' }}>
                    {o}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* ── CARD EDITOR ── */}
      {activeTab === 'editor' && (
        <div>
          <div style={{ background: '#1e2433', borderRadius: 10, padding: '1.25rem', border: '1px solid #2d3748', marginBottom: '1rem' }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: '#94a3b8', fontWeight: 600 }}>CORE FIELDS</h3>
            {(
              [
                ['Business Name', 'name'],
                ['Tagline', 'tagline'],
                ['Phone', 'phone'],
                ['Address', 'address'],
                ['Website', 'website'],
                ['Hours', 'hours'],
              ] as [string, keyof BusinessCard][]
            ).map(([lbl, key]) => {
              const meta = fieldMeta(key)
              return (
                <EditableField
                  key={key}
                  label={lbl}
                  value={fieldVal(key)}
                  inferred={meta.inferred}
                  confidence={meta.confidence}
                  onChange={(v) => setField(key as string, v)}
                />
              )
            })}
          </div>

          <div style={{ background: '#1e2433', borderRadius: 10, padding: '1.25rem', border: '1px solid #2d3748', marginBottom: '1rem' }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: '#94a3b8', fontWeight: 600 }}>SPECIALS</h3>
            <SpecialsEditor specials={specials} onChange={setSpecials} />
          </div>

          <div style={{ background: '#1e2433', borderRadius: 10, padding: '1.25rem', border: '1px solid #2d3748', marginBottom: '1.25rem' }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: '#94a3b8', fontWeight: 600 }}>SOCIAL PROFILES</h3>
            <SocialEditor socials={socials} onChange={setSocials} />
          </div>

          {saveMsg && (
            <div style={{
              marginBottom: '0.75rem', padding: '0.6rem 0.85rem', borderRadius: 6, fontSize: '0.82rem',
              background: saveMsg.startsWith('Error') ? '#ef444411' : '#22c55e11',
              color: saveMsg.startsWith('Error') ? '#ef4444' : '#22c55e',
              border: `1px solid ${saveMsg.startsWith('Error') ? '#ef444433' : '#22c55e33'}`,
            }}>
              {saveMsg}
            </div>
          )}

          <button onClick={handleSave} disabled={saving} style={{
            background: saving ? '#374151' : '#6366f1', color: '#fff',
            border: 'none', borderRadius: 8, padding: '0.6rem 1.5rem',
            fontSize: '0.9rem', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', width: '100%',
          }}>
            {saving ? 'Saving…' : 'Save & Compile Agent'}
          </button>
        </div>
      )}

      {/* ── CHANGELOG ── */}
      {activeTab === 'changelog' && (
        <ChangelogViewer changelog={changelog} loading={loading} />
      )}

      {/* ── HEALTH ── */}
      {activeTab === 'health' && (
        <HealthBadge health={health} />
      )}

      {/* ── GREETING ── */}
      {activeTab === 'greeting' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: '#e2e8f0' }}>
              Compiled Greeting
            </h3>
            <button onClick={loadGreeting} style={{
              background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6,
              padding: '0.35rem 0.9rem', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 600,
            }}>
              {greeting ? 'Recompile' : 'Load Greeting'}
            </button>
          </div>

          {/* Voice picker */}
          {voices.length > 0 && (
            <div style={{ marginBottom: '1.25rem' }}>
              <label style={labelStyle}>Voice</label>
              <select style={{ ...inputStyle, cursor: 'pointer' }}>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.provider}{v.gender ? ' · ' + v.gender : ''})
                  </option>
                ))}
              </select>
            </div>
          )}

          {greeting ? (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {(['morning', 'afternoon', 'evening', 'default'] as const).map((period) => {
                const text = greeting[period]
                if (!text) return null
                return (
                  <div key={period} style={{
                    background: '#1e2433', borderRadius: 8, padding: '1rem',
                    border: '1px solid #2d3748',
                  }}>
                    <div style={{ fontSize: '0.72rem', color: '#6366f1', fontWeight: 700, textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                      {period}
                    </div>
                    <div style={{ fontSize: '0.9rem', color: '#e2e8f0', lineHeight: 1.55 }}>{text}</div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ color: '#475569', fontSize: '0.875rem', padding: '1rem 0' }}>
              Click "Load Greeting" to compile greetings from the current card.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
