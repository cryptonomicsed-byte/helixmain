import { useState } from 'react'
import type { Special } from '../api'

interface Props {
  specials: Special[]
  onChange: (specials: Special[]) => void
}

const emptySpecial = (): Special => ({ name: '', description: '', price: '', valid_from: '', valid_until: '' })

const inputStyle: React.CSSProperties = {
  background: '#0f1117', border: '1px solid #2d3748', borderRadius: 6,
  color: '#e2e8f0', padding: '0.4rem 0.6rem', fontSize: '0.82rem', width: '100%',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.72rem', color: '#94a3b8', marginBottom: '0.2rem', display: 'block',
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
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#cbd5e1' }}>
          Specials / Offers ({specials.length})
        </span>
        <button onClick={add} style={{
          background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6,
          padding: '0.3rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600,
        }}>
          + Add Special
        </button>
      </div>

      {specials.length === 0 && (
        <div style={{ color: '#475569', fontSize: '0.82rem', padding: '0.75rem 0' }}>
          No specials yet. Add one to feature promotions in your agent greeting.
        </div>
      )}

      {specials.map((sp, i) => (
        <div key={i} style={{
          background: '#0f1117', borderRadius: 8, border: '1px solid #2d3748',
          marginBottom: '0.5rem', overflow: 'hidden',
        }}>
          {/* Header row */}
          <div
            onClick={() => setExpanded(expanded === i ? null : i)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '0.6rem 0.85rem', cursor: 'pointer',
              background: expanded === i ? '#1e2433' : 'transparent',
            }}
          >
            <span style={{ flex: 1, fontWeight: 600, fontSize: '0.85rem', color: sp.name ? '#e2e8f0' : '#475569' }}>
              {sp.name || 'Unnamed special'}
            </span>
            {sp.price && (
              <span style={{ fontSize: '0.8rem', color: '#22c55e', fontWeight: 700 }}>{sp.price}</span>
            )}
            <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{expanded === i ? '▲' : '▼'}</span>
          </div>

          {expanded === i && (
            <div style={{ padding: '0.85rem', borderTop: '1px solid #2d3748', display: 'grid', gap: '0.6rem' }}>
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
                  background: 'transparent', border: '1px solid #ef4444', color: '#ef4444',
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
