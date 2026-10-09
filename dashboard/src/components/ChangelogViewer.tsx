import type { Changelog } from '../api'

interface Props {
  changelog: Changelog | null
  loading?: boolean
}

function truncateHash(h: string) {
  return h.slice(0, 10) + '…'
}

function formatDate(ts: string) {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

export function ChangelogViewer({ changelog, loading }: Props) {
  if (loading) {
    return <div style={{ color: 'var(--fg-3)', padding: '1rem' }}>Loading changelog…</div>
  }
  if (!changelog || changelog.entries.length === 0) {
    return <div style={{ color: 'var(--fg-3)', padding: '1rem' }}>No changelog entries yet.</div>
  }

  return (
    <div style={{ position: 'relative' }}>
      {/* Timeline line */}
      <div style={{
        position: 'absolute', left: 20, top: 0, bottom: 0,
        width: 2, background: 'var(--line-2)',
      }} />

      {changelog.entries.map((entry, i) => (
        <div key={entry.hash} style={{
          position: 'relative', paddingLeft: 52, marginBottom: '1.5rem',
        }}>
          {/* Dot */}
          <div style={{
            position: 'absolute', left: 12, top: 6,
            width: 18, height: 18, borderRadius: '50%',
            background: i === 0 ? 'var(--brand-2)' : 'var(--line-2)',
            border: `2px solid ${i === 0 ? 'var(--brand-2)' : 'var(--line-2)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {i === 0 && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />}
          </div>

          <div className="glass" style={{ background: 'var(--surface)', borderRadius: 8, padding: '0.85rem 1rem',
            border: '1px solid var(--line-2)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.4rem' }}>
              <div>
                <span style={{
                  background: '#6366f133', color: 'var(--brand)', borderRadius: 4,
                  padding: '0.1rem 0.45rem', fontSize: '0.7rem', fontWeight: 700, marginRight: '0.5rem',
                }}>
                  v{entry.version}
                </span>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--fg)' }}>
                  {entry.summary}
                </span>
              </div>
              <span style={{ fontSize: '0.72rem', color: 'var(--fg-3)', whiteSpace: 'nowrap', marginLeft: '0.5rem' }}>
                {formatDate(entry.ts)}
              </span>
            </div>

            {entry.fields_changed.length > 0 && (
              <div style={{ marginBottom: '0.4rem' }}>
                {entry.fields_changed.map((f) => (
                  <span key={f} style={{
                    display: 'inline-block', fontSize: '0.7rem', color: 'var(--fg-2)',
                    background: 'var(--bg)', borderRadius: 3, padding: '0.1rem 0.4rem',
                    marginRight: '0.3rem', marginBottom: '0.2rem', border: '1px solid var(--line-2)',
                  }}>
                    {f}
                  </span>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.7rem', color: 'var(--fg-3)', marginTop: '0.25rem' }}>
              <span>by {entry.author}</span>
              <span title={entry.hash}>hash {truncateHash(entry.hash)}</span>
              {entry.prev_hash && (
                <span title={entry.prev_hash}>prev {truncateHash(entry.prev_hash)}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
