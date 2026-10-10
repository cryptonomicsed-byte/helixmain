import { useState } from 'react'
import { useCard } from './CardContext'
import { api } from '../../api'
import { Icon } from '../../components/Icon'

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

interface Prov { sources?: string[]; confidence?: number; inferred?: boolean; extractorAgent?: string }

function provFor(card: any, key: string): Prov | null {
  return card?.field_provenance?.[key] ?? null
}

/** green = owner/confirmed, amber = inferred or low confidence, grey = unknown */
function ProvBadge({ card, fieldKey }: { card: any; fieldKey: string }) {
  const p = provFor(card, fieldKey)
  if (!p) return <span className="pill" style={{ fontSize: '.66rem', opacity: .7 }}>—</span>
  const conf = typeof p.confidence === 'number' ? p.confidence : 0.5
  const confirmed = p.sources?.includes('owner') || (!p.inferred && conf >= 0.8)
  if (confirmed) {
    return <span className="pill pill-ok" style={{ fontSize: '.66rem' }}><Icon name="check" size={10} /> confirmed</span>
  }
  return <span className="pill pill-warn" style={{ fontSize: '.66rem' }}>inferred {Math.round(conf * 100)}%</span>
}

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

function Section({ title, count, children, defaultOpen = true }: {
  title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="panel" style={{ marginBottom: '.75rem', overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '.6rem', background: 'transparent',
          border: 0, padding: '.75rem 1rem', cursor: 'pointer', color: 'var(--fg)', textAlign: 'left',
        }}>
        <Icon name="arrow" size={14} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 180ms' }} />
        <span style={{ fontWeight: 650, fontSize: '.92rem', flex: 1 }}>{title}</span>
        {typeof count === 'number' && <span className="pill" style={{ fontSize: '.68rem' }}>{count}</span>}
      </button>
      {open && <div style={{ padding: '0 1rem 1rem', borderTop: '1px solid var(--line)' }}>{children}</div>}
    </div>
  )
}

/** Editable scalar row with provenance + confirm. */
function FieldRow({ card, fieldKey, label, value, onSaved }: {
  card: any; fieldKey: string; label: string; value: string; onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(value)
  const [saving, setSaving] = useState(false)

  const section = fieldKey.split('.')[0]
  const field = fieldKey.split('.').slice(1).join('.')

  async function save(confirmKey?: string) {
    setSaving(true)
    try {
      const patch = confirmKey
        ? {}                                             // confirm only: no value change
        : { [section]: { [field]: val } }
      await api.updateCard(card.id, patch, [confirmKey ?? fieldKey], `Edited ${label}`)
      setEditing(false)
      onSaved()
    } catch (e) {
      console.warn('[CardTab] save failed:', e)
    } finally {
      setSaving(false)
    }
  }

  const p = provFor(card, fieldKey)
  const inferred = p?.inferred || (typeof p?.confidence === 'number' && p.confidence < 0.8)
  const empty = !value

  return (
    <div style={{ padding: '.5rem 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.25rem' }}>
        <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</span>
        <ProvBadge card={card} fieldKey={fieldKey} />
        <div style={{ flex: 1 }} />
        {!editing && (
          <>
            {inferred && (
              <button className="btn btn-ghost" onClick={() => save(fieldKey)} disabled={saving}
                style={{ fontSize: '.72rem', padding: '.2rem .5rem' }}>Confirm</button>
            )}
            <button className="btn btn-ghost" onClick={() => { setVal(value); setEditing(true) }}
              style={{ fontSize: '.72rem', padding: '.2rem .5rem' }}>Edit</button>
          </>
        )}
      </div>
      {editing ? (
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <input autoFocus value={val} onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            style={{ flex: 1, background: 'rgba(0,0,0,.25)', border: '1px solid var(--line-2)', borderRadius: 8,
                     color: 'var(--fg)', padding: '.4rem .6rem', fontSize: '.85rem', outline: 'none' }} />
          <button className="btn btn-primary" onClick={() => save()} disabled={saving}
            style={{ fontSize: '.75rem', padding: '.35rem .7rem' }}>{saving ? '…' : 'Save'}</button>
          <button className="btn btn-ghost" onClick={() => setEditing(false)} style={{ fontSize: '.75rem', padding: '.35rem .6rem' }}>Cancel</button>
        </div>
      ) : (
        <div style={{ fontSize: '.88rem', color: empty ? 'var(--fg-3)' : 'var(--fg)', fontStyle: empty ? 'italic' : 'normal' }}>
          {empty ? 'not set' : value}
        </div>
      )}
    </div>
  )
}

/** Read-only chip list (arrays). */
function Chips({ items, tone }: { items: string[]; tone?: string }) {
  if (!items || items.length === 0) return <div className="sub" style={{ fontSize: '.82rem', fontStyle: 'italic' }}>none</div>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem', padding: '.35rem 0' }}>
      {items.map((it, i) => <span key={i} className="pill" style={tone ? { color: tone, borderColor: tone } : undefined}>{it}</span>)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card tab
// ---------------------------------------------------------------------------

export function CardTab() {
  const { id, card, reload } = useCard()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  if (!card) return <div className="sub" style={{ padding: '2rem' }}>No card loaded.</div>

  const identity = card.identity ?? {}
  const voice = card.voice ?? {}
  const ops = card.operations ?? {}
  const strategy = card.strategy ?? {}
  const visual = card.visual ?? {}
  const personas = card.customers?.personas ?? []
  const offerings = Array.isArray(card.offerings) ? card.offerings : []
  const competitors = Array.isArray(card.competitors) ? card.competitors : []

  async function confirmAllInferred() {
    const keys = Object.entries(card.field_provenance ?? {})
      .filter(([, v]: [string, any]) => v?.inferred || (typeof v?.confidence === 'number' && v.confidence < 0.8))
      .map(([k]) => k)
    if (keys.length === 0) { setNotice('Nothing inferred to confirm.'); return }
    setBusy(true)
    try {
      await api.updateCard(card.id, {}, keys, `Confirmed ${keys.length} inferred field(s)`)
      setNotice(`Confirmed ${keys.length} field(s).`)
      reload()
    } catch (e) {
      setNotice(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.9rem', flexWrap: 'wrap' }}>
        <span className="sub" style={{ fontSize: '.82rem' }}>
          Every field shows where it came from. Inferred values are capped at 55% until you confirm them.
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={confirmAllInferred} disabled={busy} style={{ fontSize: '.78rem' }}>
          <Icon name="check" size={14} /> {busy ? 'Working…' : 'Confirm all inferred'}
        </button>
      </div>
      {notice && <div className="pill pill-ok" style={{ marginBottom: '.8rem', display: 'inline-block' }}>{notice}</div>}

      <Section title="Identity" count={[identity.name, identity.tagline, identity.website, identity.phone].filter(Boolean).length}>
        <FieldRow card={card} fieldKey="identity.name" label="Name" value={identity.name ?? ''} onSaved={reload} />
        <FieldRow card={card} fieldKey="identity.tagline" label="Tagline" value={identity.tagline ?? ''} onSaved={reload} />
        <FieldRow card={card} fieldKey="identity.elevatorPitch" label="Elevator pitch" value={identity.elevatorPitch ?? ''} onSaved={reload} />
        <FieldRow card={card} fieldKey="identity.website" label="Website" value={identity.website ?? ''} onSaved={reload} />
        <FieldRow card={card} fieldKey="identity.phone" label="Phone" value={identity.phone ?? ''} onSaved={reload} />
        <FieldRow card={card} fieldKey="identity.location" label="Location" value={identity.location ?? ''} onSaved={reload} />
        <div style={{ padding: '.5rem 0' }}>
          <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Values</span>
          <Chips items={Array.isArray(identity.values) ? identity.values : []} />
        </div>
      </Section>

      <Section title="Offerings" count={offerings.length}>
        {offerings.length === 0 ? <div className="sub" style={{ fontSize: '.84rem', fontStyle: 'italic' }}>No offerings extracted.</div> : (
          offerings.map((o: any, i: number) => (
            <div key={i} style={{ display: 'flex', gap: '.6rem', alignItems: 'center', padding: '.45rem 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ flex: 1, fontSize: '.88rem' }}>{o.name}</span>
              <span className="pill" style={{ fontSize: '.68rem' }}>{o.kind ?? 'service'}</span>
              <span className="sub" style={{ fontSize: '.74rem' }}>{o.price == null ? 'price —' : `$${o.price}`}</span>
            </div>
          ))
        )}
      </Section>

      <Section title="Hours & operations" defaultOpen={false}>
        <FieldRow card={card} fieldKey="operations.hours" label="Hours" value={ops.hours ?? ''} onSaved={reload} />
        <div style={{ padding: '.5rem 0' }}>
          <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Channels</span>
          <Chips items={(ops.channels ?? []).map((c: any) => `${c.type}${c.handle ? `: ${c.handle}` : ''}`)} />
        </div>
      </Section>

      <Section title="Voice & tone" defaultOpen={false}>
        <div style={{ padding: '.5rem 0' }}>
          <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Tone</span>
          <Chips items={Array.isArray(voice.tone) ? voice.tone : []} />
        </div>
        <FieldRow card={card} fieldKey="voice.personality" label="Personality" value={voice.personality ?? ''} onSaved={reload} />
        <div style={{ padding: '.5rem 0' }}>
          <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Never do</span>
          <Chips items={Array.isArray(voice.donts) ? voice.donts : []} tone="var(--bad)" />
        </div>
      </Section>

      <Section title="Visual identity" defaultOpen={false}
        count={(visual.colors?.length ?? 0) + (visual.fonts?.length ?? 0)}>
        <div style={{ padding: '.5rem 0' }}>
          <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Palette</span>
          {(visual.colors?.length ?? 0) === 0 ? <div className="sub" style={{ fontSize: '.82rem', fontStyle: 'italic' }}>none scraped</div> : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', marginTop: '.35rem' }}>
              {visual.colors.map((c: any, i: number) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.78rem', color: 'var(--fg-2)' }}>
                  <span style={{ width: 18, height: 18, borderRadius: 5, background: c.hex, border: '1px solid var(--line-2)' }} />
                  <span className="mono">{c.hex}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: '.5rem 0' }}>
          <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Fonts</span>
          <Chips items={(visual.fonts ?? []).map((f: any) => f.family)} />
        </div>
        {(visual.ctas?.length ?? 0) > 0 && (
          <div style={{ padding: '.5rem 0' }}>
            <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Calls to action on site</span>
            <Chips items={visual.ctas} />
          </div>
        )}
      </Section>

      <Section title="Strategy" defaultOpen={false}>
        <FieldRow card={card} fieldKey="strategy.positioning" label="Positioning" value={strategy.positioning ?? ''} onSaved={reload} />
        <div style={{ padding: '.5rem 0' }}>
          <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Key messaging</span>
          <Chips items={Array.isArray(strategy.key_messaging) ? strategy.key_messaging : []} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '.6rem', paddingTop: '.5rem' }}>
          {(['strengths', 'weaknesses', 'opportunities', 'threats'] as const).map((k) => (
            <div key={k}>
              <span className="sub" style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>{k}</span>
              <Chips items={Array.isArray(strategy.swot?.[k]) ? strategy.swot[k] : []} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Policies" defaultOpen={false}
        count={(card.policies?.length ?? 0) + (card.policy_donts?.length ?? 0)}>
        {(card.policies ?? []).map((p: any, i: number) => (
          <div key={i} style={{ padding: '.45rem 0', borderBottom: '1px solid var(--line)' }}>
            <div className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>{p.topic}</div>
            <div style={{ fontSize: '.86rem' }}>{p.rule}</div>
          </div>
        ))}
        {(card.policy_donts?.length ?? 0) > 0 && (
          <div style={{ padding: '.5rem 0' }}>
            <span className="sub" style={{ fontSize: '.74rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>Human confirm required</span>
            <Chips items={card.policy_donts} tone="var(--warn)" />
          </div>
        )}
        {(card.policies ?? []).length === 0 && (card.policy_donts ?? []).length === 0 &&
          <div className="sub" style={{ fontSize: '.84rem', fontStyle: 'italic' }}>No policies extracted.</div>}
      </Section>

      <Section title="Customers" defaultOpen={false} count={personas.length}>
        {personas.length === 0 ? <div className="sub" style={{ fontSize: '.84rem', fontStyle: 'italic' }}>No personas extracted.</div> : (
          personas.map((p: any, i: number) => (
            <div key={i} style={{ padding: '.6rem 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{p.name}{p.age_range ? ` · ${p.age_range}` : ''}</div>
              <div className="sub" style={{ fontSize: '.8rem', marginTop: 2 }}>{p.role}</div>
              {Array.isArray(p.pain_points) && <Chips items={p.pain_points} />}
            </div>
          ))
        )}
      </Section>

      <Section title="Competitors" defaultOpen={false} count={competitors.length}>
        {competitors.length === 0 ? <div className="sub" style={{ fontSize: '.84rem', fontStyle: 'italic' }}>No competitors extracted.</div> : (
          competitors.map((c: any, i: number) => (
            <div key={i} style={{ padding: '.45rem 0', borderBottom: '1px solid var(--line)', fontSize: '.86rem' }}>
              <strong>{c.name}</strong> <span className="sub">— {c.positioning}</span>
            </div>
          ))
        )}
      </Section>

      <div className="sub" style={{ fontSize: '.75rem', marginTop: '.5rem' }}>
        Card id <span className="mono">{id}</span> · changes are versioned and hash-chained into History.
      </div>
    </div>
  )
}
