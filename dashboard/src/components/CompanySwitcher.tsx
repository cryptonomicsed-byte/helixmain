/* Company switcher — replaces the raw <select>. Glass dropdown with search. */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useHelixStore } from '../store'
import { Icon } from './Icon'

export function CompanySwitcher() {
  const { companies, currentCompany, setCurrentCompany } = useHelixStore()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])

  const filtered = companies.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))

  function pick(id: string) {
    const c = companies.find((x) => x.id === id) ?? null
    setCurrentCompany(c)
    setOpen(false); setQ('')
    if (c) navigate(`/company/${c.id}`)
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen((o) => !o)} style={{ minWidth: 190, justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '.5rem', overflow: 'hidden' }}>
          <Icon name="company" size={15} />
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>
            {currentCompany?.name ?? 'Select company'}
          </span>
        </span>
        <Icon name="arrow" size={13} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 200ms cubic-bezier(.34,1.56,.64,1)', opacity: .6 }} />
      </button>

      {open && (
        <div className="glass reveal" style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 260, zIndex: 40, padding: 8, boxShadow: 'var(--shadow-lg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.35rem .5rem', borderBottom: '1px solid var(--line)', marginBottom: 6 }}>
            <Icon name="search" size={14} style={{ opacity: .5 }} />
            <input
              autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search companies…"
              style={{ background: 'transparent', border: 0, outline: 'none', color: 'var(--fg)', fontSize: '.82rem', width: '100%' }}
            />
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div className="sub" style={{ padding: '.6rem .5rem' }}>No matches</div>
            )}
            {filtered.map((c) => {
              const active = c.id === currentCompany?.id
              return (
                <button key={c.id} onClick={() => pick(c.id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                    padding: '.5rem .55rem', borderRadius: 9, border: 0, cursor: 'pointer', textAlign: 'left',
                    background: active ? 'rgba(129,140,248,.12)' : 'transparent',
                    color: active ? 'var(--brand)' : 'var(--fg-2)', fontSize: '.82rem',
                  }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  {active && <Icon name="check" size={14} />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
