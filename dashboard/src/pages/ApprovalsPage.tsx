import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { ApprovalItem, AuditEntry } from '../api'

const POLL_MS = 5000

const riskColor: Record<string, string> = {
  low:    '#22c55e',
  medium: '#f59e0b',
  high:   '#ef4444',
}

function RiskBadge({ level }: { level: string }) {
  const c = riskColor[level] ?? '#94a3b8'
  return (
    <span style={{
      fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase',
      color: c, background: c + '18', borderRadius: 4, padding: '0.1rem 0.45rem',
      border: `1px solid ${c}44`,
    }}>
      {level}
    </span>
  )
}

export function ApprovalsPage() {
  const [pending, setPending]     = useState<ApprovalItem[]>([])
  const [audit, setAudit]         = useState<AuditEntry[]>([])
  const [reachable, setReachable] = useState(true)
  const [acting, setActing]       = useState<Set<string>>(new Set())
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function poll() {
    try {
      const data = await api.gkQueue()
      setPending(data.pending ?? [])
      setAudit(data.audit ?? [])
      setReachable(true)
    } catch {
      setReachable(false)
    }
  }

  useEffect(() => {
    poll()
    timerRef.current = setInterval(poll, POLL_MS)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  async function decide(id: string, approve: boolean) {
    setActing((s) => new Set([...s, id]))
    try {
      if (approve) await api.gkApprove(id)
      else         await api.gkDeny(id)
      await poll()
    } catch (e) {
      console.error('decision failed', e)
    } finally {
      setActing((s) => { const n = new Set(s); n.delete(id); return n })
    }
  }

  function formatTime(ts: string) {
    try { return new Date(ts).toLocaleTimeString() } catch { return ts }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>
            SparkGatekeeper
          </h1>
          <p style={{ color: '#64748b', fontSize: '0.875rem', marginTop: '0.35rem' }}>
            Pending approvals · polls every 5s
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
            background: reachable ? '#22c55e' : '#ef4444',
          }} />
          <span style={{ fontSize: '0.75rem', color: reachable ? '#22c55e' : '#ef4444' }}>
            {reachable ? 'Connected' : 'Unreachable'}
          </span>
        </div>
      </div>

      {/* Pending queue */}
      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
          Pending ({pending.length})
        </h2>

        {!reachable && (
          <div style={{
            background: '#1e2433', borderRadius: 10, padding: '1.5rem', textAlign: 'center',
            border: '1px solid #2d3748', color: '#64748b', fontSize: '0.875rem',
          }}>
            No pending approvals — SparkGatekeeper is unreachable at port 9100.
          </div>
        )}

        {reachable && pending.length === 0 && (
          <div style={{
            background: '#1e2433', borderRadius: 10, padding: '1.5rem', textAlign: 'center',
            border: '1px solid #2d3748', color: '#64748b', fontSize: '0.875rem',
          }}>
            Queue is empty. All clear.
          </div>
        )}

        {pending.map((item) => (
          <div key={item.id} style={{
            background: '#1e2433', borderRadius: 10, padding: '1.1rem 1.25rem',
            border: '1px solid #2d3748', marginBottom: '0.75rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.6rem' }}>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <RiskBadge level={item.risk_level} />
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#e2e8f0' }}>{item.action}</span>
              </div>
              <span style={{ fontSize: '0.72rem', color: '#475569', whiteSpace: 'nowrap', marginLeft: '0.5rem' }}>
                {formatTime(item.created_at)}
              </span>
            </div>

            <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>
              <strong style={{ color: '#64748b' }}>Agent:</strong> {item.agent}
            </div>

            <div style={{
              fontSize: '0.82rem', color: '#cbd5e1', background: '#0f1117',
              borderRadius: 6, padding: '0.5rem 0.7rem', marginBottom: '0.85rem',
              borderLeft: '3px solid #6366f1',
            }}>
              {item.customer_context}
            </div>

            <div style={{ display: 'flex', gap: '0.6rem' }}>
              <button
                onClick={() => decide(item.id, true)}
                disabled={acting.has(item.id)}
                style={{
                  flex: 1, background: acting.has(item.id) ? '#374151' : '#22c55e',
                  color: '#fff', border: 'none', borderRadius: 6,
                  padding: '0.45rem', fontSize: '0.85rem', fontWeight: 700,
                  cursor: acting.has(item.id) ? 'not-allowed' : 'pointer',
                }}
              >
                {acting.has(item.id) ? '…' : 'Approve'}
              </button>
              <button
                onClick={() => decide(item.id, false)}
                disabled={acting.has(item.id)}
                style={{
                  flex: 1, background: 'transparent',
                  color: '#ef4444', border: '1px solid #ef4444', borderRadius: 6,
                  padding: '0.45rem', fontSize: '0.85rem', fontWeight: 700,
                  cursor: acting.has(item.id) ? 'not-allowed' : 'pointer',
                }}
              >
                {acting.has(item.id) ? '…' : 'Deny'}
              </button>
            </div>
          </div>
        ))}
      </section>

      {/* Audit log */}
      {audit.length > 0 && (
        <section>
          <h2 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
            Recent Decisions ({audit.length})
          </h2>
          <div style={{ background: '#1e2433', borderRadius: 10, border: '1px solid #2d3748', overflow: 'hidden' }}>
            {audit.map((entry, i) => (
              <div key={entry.id} style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem',
                padding: '0.65rem 1rem',
                borderBottom: i < audit.length - 1 ? '1px solid #2d3748' : 'none',
              }}>
                <span style={{
                  fontSize: '0.72rem', fontWeight: 700,
                  color: entry.decision === 'approved' ? '#22c55e' : '#ef4444',
                  width: 52, flexShrink: 0,
                }}>
                  {entry.decision === 'approved' ? '✓ APPR' : '✗ DENY'}
                </span>
                <span style={{ flex: 1, fontSize: '0.82rem', color: '#cbd5e1' }}>{entry.action}</span>
                <span style={{ fontSize: '0.72rem', color: '#475569', whiteSpace: 'nowrap' }}>
                  {formatTime(entry.decided_at)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
