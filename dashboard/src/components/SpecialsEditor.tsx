import { useState } from 'react'
import type { Special } from '../api'

interface Props {
  specials: Special[]
  onChange: (specials: Special[]) => void
}

const emptySpecial = (): Special => ({ name: '', description: '', price: '', valid_from: '', valid_until: '' })

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)', border: '1px solid var(--line-2)', borderRadius: 6,
  color: 'var(--fg)', padding: '0.4rem 0.6rem', fontSize: '0.82rem', width: '100%',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.72rem', color: 'var(--fg-2)', marginBottom: '0.2rem', display: 'block',
}

export function SpecialsEditor({ specials, onChange }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null)

  function update(i: number, patch: Partial<Special>) {
    const next = specials.map((s, idx) => idx === i ? { ...s, ...patch } : s)
    onChange(next)
  }

  function add() {
    onChange([...specials, emptySpecial()])
    setExpanded(specials.length)
  }

  function remove(i: number) {
    onChange(specials.filter((_, idx) => idx !== i))
    setExpanded(null)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--fg)' }}>
          Specials / Offers ({specials.length})
        </span>
        <button onClick={add} style={{
          background: 'var(--brand-2)', color: '#fff', border: 'none', borderRadius: 6,
          padding: '0.3rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600,
        }}>
          + Add Special
        </button>
      </div>

      {specials.length === 0 && (
        <div style={{ color: 'var(--fg-3)', fontSize: '0.82rem', padding: '0.75rem 0' }}>
          No specials yet. Add one to feature promotions in your agent greeting.
        </div>
      )}

      {specials.map((sp, i) => (
        <div key={i} style={{
          background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--line-2)',
          marginBottom: '0.5rem', overflow: 'hidden',
        }}>
          {/* Header row */}
          <div
            onClick={() => setExpanded(expanded === i ? null : i)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '0.6rem 0.85rem', cursor: 'pointer',
              background: expanded === i ? 'var(--surface)' : 'transparent',
            }}
          >
            <span style={{ flex: 1, fontWeight: 600, fontSize: '0.85rem', color: sp.name ? 'var(--fg)' : 'var(--fg-3)' }}>
              {sp.name || 'Unnamed special'}
            </span>
            {sp.price && (
              <span style={{ fontSize: '0.8rem', color: 'var(--ok)', fontWeight: 700 }}>{sp.price}</span>
            )}
            <span style={{ color: 'var(--fg-3)', fontSize: '0.75rem' }}>{expanded === i ? '▲' : '▼'}</span>
          </div>

          {expanded === i && (
            <div style={{ padding: '0.85rem', borderTop: '1px solid var(--line-2)', display: 'grid', gap: '0.6rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                <div>
                  <label style={labelStyle}>Name *</label>
                  <input style={inputStyle} value={sp.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Happy Hour" />
                </div>
                <div>
                  <label style={labelStyle}>Price</label>
                  <input style={inputStyle} value={sp.price ?? ''} onChange={(e) => update(i, { price: e.target.value })} placeholder="$5 drafts" />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Description</label>
                <input style={inputStyle} value={sp.description ?? ''} onChange={(e) => update(i, { description: e.target.value })} placeholder="Half-price appetizers and drink specials" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                <div>
                  <label style={labelStyle}>Valid From</label>
                  <input style={inputStyle} type="date" value={sp.valid_from ?? ''} onChange={(e) => update(i, { valid_from: e.target.value })} />
                </div>
                <div>
                  <label style={labelStyle}>Valid Until</label>
                  <input style={inputStyle} type="date" value={sp.valid_until ?? ''} onChange={(e) => update(i, { valid_until: e.target.value })} />
                </div>
              </div>
              <div style={{ textAlign: 'right', marginTop: '0.25rem' }}>
                <button onClick={() => remove(i)} style={{
                  background: 'transparent', border: '1px solid var(--bad)', color: 'var(--bad)',
                  borderRadius: 6, padding: '0.3rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer',
                }}>
                  Remove
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
