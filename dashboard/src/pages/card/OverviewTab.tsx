import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCard } from './CardContext'
import { api } from '../../api'
import { Icon } from '../../components/Icon'

function humanize(k: string): string {
  return k.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

interface Attention { label: string; tab: string }

export function OverviewTab() {
  const { id, card, health, changelog, publicUrl } = useCard()
  const navigate = useNavigate()
  const [pending, setPending] = useState<number | null>(null)
  const [siteGenerated, setSiteGenerated] = useState(false)

  useEffect(() => {
    let live = true
    api.gkQueue()
      .then(({ pending }) => { if (live) setPending(pending.filter((p) => (p as any).card_id === id || true).length) })
      .catch(() => { if (live) setPending(null) })
    api.listSites()
      .then((s) => { if (live) setSiteGenerated((s.companies ?? []).includes(id)) })
      .catch(() => { /* ignore */ })
    return () => { live = false }
  }, [id])

  const offerings: any[] = Array.isArray(card?.offerings) ? card.offerings : []
  const checks: Record<string, boolean> = health?.checks ?? {}
  const failing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
  const passing = Object.entries(checks).filter(([, v]) => v).map(([k]) => k)
  const score = typeof health?.score === 'number' ? health.score : 0

  // "What needs me" — derived from real state, never invented.
  const attention: Attention[] = []
  if (!siteGenerated) attention.push({ label: 'No landing page generated yet', tab: 'site' })
  if (!card?.voice?.tone?.length) attention.push({ label: 'Voice / brand tone not configured', tab: 'voice' })
  if (offerings.length === 0) attention.push({ label: 'No offerings on the card', tab: 'card' })
  if (typeof pending === 'number' && pending > 0) attention.push({ label: `${pending} approval${pending === 1 ? '' : 's'} pending`, tab: 'approvals' })
  for (const f of failing) attention.push({ label: humanize(f), tab: 'card' })

  const entries: any[] = Array.isArray(changelog?.entries) ? changelog.entries : []

  return (
    <div>
      {/* Attention */}
      <div className="panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600, marginBottom: '.6rem' }}>
          What needs you
        </div>
        {attention.length === 0 ? (
          <div style={{ color: 'var(--ok)', fontSize: '.88rem', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
            <Icon name="check" size={16} /> Nothing outstanding — this card is fully configured.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.45rem' }}>
            {attention.map((a, i) => (
              <button key={i} onClick={() => navigate(`/card/${id}/${a.tab}`)}
                className="glass-hover"
                style={{
                  display: 'flex', alignItems: 'center', gap: '.6rem', width: '100%', textAlign: 'left',
                  background: 'rgba(251,191,36,.06)', border: '1px solid rgba(251,191,36,.22)',
                  borderRadius: 10, padding: '.55rem .7rem', cursor: 'pointer', color: 'var(--fg)',
                }}>
                <span style={{ color: 'var(--warn)', display: 'grid', placeItems: 'center' }}><Icon name="spark" size={14} /></span>
                <span style={{ flex: 1, fontSize: '.86rem' }}>{a.label}</span>
                <span className="sub" style={{ fontSize: '.78rem' }}>Fix →</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Bento: health + stats */}
      <div className="bento" style={{ marginBottom: '1rem' }}>
        <div className="col-6 panel" style={{ padding: '1rem 1.25rem' }}>
          <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600, marginBottom: '.6rem' }}>
            Card health
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '.6rem', marginBottom: '.6rem' }}>
            <span className="stat-val" style={{ color: score >= 85 ? 'var(--ok)' : score >= 60 ? 'var(--warn)' : 'var(--bad)' }}>{score}%</span>
            <span className="sub">{passing.length}/{passing.length + failing.length} checks passing</span>
          </div>
          <div className="meter" style={{ marginBottom: '.85rem' }}><i style={{ width: `${score}%` }} /></div>
          {failing.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem' }}>
              {failing.map((f) => <span key={f} className="pill pill-warn">{humanize(f)}</span>)}
            </div>
          )}
          {Array.isArray(health?.suggestions) && health.suggestions.length > 0 && (
            <ul style={{ margin: '.7rem 0 0', paddingLeft: '1.1rem', color: 'var(--fg-2)', fontSize: '.82rem', lineHeight: 1.5 }}>
              {health.suggestions.slice(0, 4).map((s: string, i: number) => <li key={i}>{s}</li>)}
            </ul>
          )}
        </div>

        <div className="col-6 panel" style={{ padding: '1rem 1.25rem' }}>
          <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600, marginBottom: '.6rem' }}>
            At a glance
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '.75rem' }}>
            {[
              { k: 'Card version', v: `v${card?.version ?? 1}` },
              { k: 'Offerings', v: String(offerings.length) },
              { k: 'Approvals', v: pending === null ? '—' : String(pending) },
              { k: 'Site', v: siteGenerated ? 'generated' : 'none' },
            ].map((s) => (
              <div key={s.k}>
                <div className="sub" style={{ fontSize: '.74rem' }}>{s.k}</div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem', marginTop: 2 }}>{s.v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '.9rem', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={() => navigate(`/card/${id}/card`)}><Icon name="card" size={14} /> Edit card</button>
            {siteGenerated && (
              <button className="btn btn-ghost" onClick={() => window.open(publicUrl, '_blank', 'noopener')}><Icon name="globe" size={14} /> Public page</button>
            )}
          </div>
        </div>
      </div>

      {/* Recent activity */}
      <div className="panel" style={{ padding: '1rem 1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.6rem' }}>
          <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600 }}>
            Recent activity
          </div>
          <button className="btn btn-ghost" onClick={() => navigate(`/card/${id}/history`)} style={{ fontSize: '.78rem', padding: '.25rem .6rem' }}>
            Full history →
          </button>
        </div>
        {entries.length === 0 ? (
          <div className="sub" style={{ fontSize: '.84rem' }}>No changes recorded yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {entries.slice(0, 6).map((e, i) => (
              <div key={i} style={{
                display: 'flex', gap: '.85rem', alignItems: 'baseline', padding: '.5rem 0',
                borderBottom: i < Math.min(entries.length, 6) - 1 ? '1px solid var(--line)' : undefined,
              }}>
                <span className="mono" style={{ fontSize: '.74rem', color: 'var(--brand)', minWidth: 32 }}>v{e.version}</span>
                <span style={{ flex: 1, fontSize: '.84rem', color: 'var(--fg-2)' }}>{e.summary || (e.fields_changed ?? []).join(', ')}</span>
                <span className="sub" style={{ fontSize: '.74rem' }}>{e.ts ? new Date(e.ts).toLocaleDateString() : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
