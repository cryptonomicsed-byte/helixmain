import { useEffect, useState } from 'react'
import { useCard } from './CardContext'
import { api } from '../../api'
import { Icon } from '../../components/Icon'

export function HistoryTab() {
  const { id, changelog } = useCard()
  const [verify, setVerify] = useState<{ valid: boolean; brokenAt?: number; error?: string } | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api.verifyChangelog(id).then((v) => { if (live) setVerify(v) }).catch(() => { if (live) setVerify(null) })
    return () => { live = false }
  }, [id, changelog])

  const entries: any[] = Array.isArray(changelog?.entries) ? changelog.entries : []
  // newest first
  const ordered = [...entries].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))

  async function downloadMarkdown() {
    setBusy(true)
    try {
      const md = await api.changelogMarkdown(id)
      const blob = new Blob([md], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${id}-history.md`; a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.warn('[HistoryTab] export failed:', e)
    } finally { setBusy(false) }
  }

  return (
    <div>
      {/* Chain status */}
      <div className="panel" style={{ padding: '.85rem 1.25rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
        <Icon name="shield" size={16} style={{ color: verify?.valid ? 'var(--ok)' : 'var(--warn)' }} />
        <span style={{ fontSize: '.88rem', fontWeight: 600 }}>Hash chain</span>
        {verify === null ? (
          <span className="pill">unavailable</span>
        ) : verify.valid ? (
          <span className="pill pill-ok"><Icon name="check" size={11} /> intact · {entries.length} entries</span>
        ) : (
          <span className="pill pill-bad">broken{typeof verify.brokenAt === 'number' ? ` at #${verify.brokenAt}` : ''}</span>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={downloadMarkdown} disabled={busy || entries.length === 0} style={{ fontSize: '.78rem' }}>
          <Icon name="layers" size={13} /> {busy ? 'Exporting…' : 'Export history (.md)'}
        </button>
      </div>

      {ordered.length === 0 ? (
        <div className="sub" style={{ fontSize: '.88rem', padding: '1rem' }}>
          No versions recorded yet. Changes made in the Card tab appear here.
        </div>
      ) : (
        <div className="panel" style={{ overflow: 'hidden' }}>
          {ordered.map((e, i) => {
            const isOpen = open === e.version
            const changed: string[] = Array.isArray(e.fieldsChanged) ? e.fieldsChanged : []
            return (
              <div key={i} style={{ borderBottom: i < ordered.length - 1 ? '1px solid var(--line)' : undefined }}>
                <button onClick={() => setOpen(isOpen ? null : e.version)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: '.7rem', background: 'transparent',
                    border: 0, padding: '.65rem 1rem', cursor: 'pointer', color: 'var(--fg)', textAlign: 'left',
                  }}>
                  <span className="mono" style={{ fontSize: '.78rem', color: 'var(--brand)', minWidth: 34 }}>v{e.version}</span>
                  <span style={{ flex: 1, fontSize: '.86rem' }}>{e.note || e.mutationType || 'change'}</span>
                  <span className="pill" style={{ fontSize: '.66rem' }}>{e.author || 'system'}</span>
                  <span className="sub" style={{ fontSize: '.74rem' }}>{e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}</span>
                  <Icon name="arrow" size={13} style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 160ms', opacity: .6 }} />
                </button>
                {isOpen && (
                  <div style={{ padding: '0 1rem 1rem', background: 'rgba(0,0,0,.18)' }}>
                    <div className="sub" style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.05em', margin: '.5rem 0 .3rem' }}>
                      Fields changed
                    </div>
                    {changed.length === 0
                      ? <div className="sub" style={{ fontSize: '.8rem', fontStyle: 'italic' }}>none recorded</div>
                      : <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem' }}>
                          {changed.map((f, j) => <span key={j} className="pill" style={{ fontSize: '.7rem' }}>{f}</span>)}
                        </div>}
                    <div className="sub" style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.05em', margin: '.7rem 0 .3rem' }}>
                      Chain
                    </div>
                    <div className="mono" style={{ fontSize: '.72rem', color: 'var(--fg-3)', wordBreak: 'break-all', lineHeight: 1.6 }}>
                      hash {e.entryHash || '—'}<br />
                      prev {e.previousHash || 'genesis'}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
