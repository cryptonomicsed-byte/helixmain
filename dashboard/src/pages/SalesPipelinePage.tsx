import { useState, useEffect, useCallback } from 'react'
import { useHelixStore } from '../store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActivityEntry {
  timestamp: string
  type: string
  detail: string
}

interface LeadRow {
  id: string
  name: string
  company?: string
  website?: string
  phone?: string
  email: string
  score: number
  tier?: 'hot' | 'warm' | 'cold' | 'disqualified'
  status: 'new' | 'contacted' | 'qualified' | 'converted' | 'lost'
  signals: string[]
  activityLog: ActivityEntry[]
}

interface OutreachDraft {
  leadId: string
  subjectLine: string
  emailBody: string
  closingScript: string
  objectionRebuttals: Record<string, string>
  followUpSequence: string[]
  linkedinMessage: string
  callScript: string
  holdQueueId?: string
}

interface DealReview {
  leadId: string
  dealHealth: 'strong' | 'at-risk' | 'stalled'
  redFlags: string[]
  positiveSignals: string[]
  recommendedActions: string[]
  probabilityToClose: number
  reviewedAt: string
}

const HEALTH_COLOR: Record<string, string> = {
  strong:     'var(--ok)',
  'at-risk':  'var(--warn)',
  stalled:    'var(--bad)',
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLUMNS: { key: LeadRow['status']; label: string; color: string }[] = [
  { key: 'new',       label: 'New',       color: 'var(--info)' },
  { key: 'contacted', label: 'Contacted', color: 'var(--warn)' },
  { key: 'qualified', label: 'Qualified', color: 'var(--violet)' },
  { key: 'converted', label: 'Converted', color: 'var(--ok)' },
  { key: 'lost',      label: 'Lost',      color: 'var(--fg-2)' },
]

const TIER_MAP: Record<string, { icon: string; color: string }> = {
  hot:          { icon: '🔥', color: 'var(--bad)' },
  warm:         { icon: '♨️',  color: 'var(--warn)' },
  cold:         { icon: '🧊', color: 'var(--info)' },
  disqualified: { icon: '✗',  color: 'var(--fg-2)' },
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TierBadge({ tier }: { tier?: string }) {
  if (!tier) return null
  const t = TIER_MAP[tier]
  if (!t) return null
  return (
    <span style={{ color: t.color, fontSize: '0.78rem', fontWeight: 600 }}>
      {t.icon} {tier}
    </span>
  )
}

function ScoreBadge({ score }: { score: number }) {
  const bg = score >= 70 ? '#22543d' : score >= 40 ? '#744210' : 'var(--line-2)'
  const color = score >= 70 ? 'var(--ok)' : score >= 40 ? 'var(--warn)' : 'var(--fg-2)'
  return (
    <span style={{
      background: bg, color, borderRadius: 4,
      padding: '1px 6px', fontSize: '0.75rem', fontWeight: 700,
    }}>
      {score}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

interface PanelProps {
  lead: LeadRow
  companyId: string
  cardId: string
  onClose: () => void
  onLeadUpdate: (updated: LeadRow) => void
}

function LeadPanel({ lead, companyId, cardId, onClose, onLeadUpdate }: PanelProps) {
  const [outreach, setOutreach]   = useState<OutreachDraft | null>(null)
  const [outLoading, setOutLoading] = useState(false)
  const [submitLoading, setSubmitLoading] = useState(false)
  const [holdId, setHoldId]       = useState<string | null>(null)
  const [activity, setActivity]   = useState<ActivityEntry[]>(lead.activityLog ?? [])
  const [review, setReview]       = useState<DealReview | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)

  useEffect(() => {
    // Refresh activity log from server
    fetch(`/api/sales/leads/${lead.id}/activity`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: { activityLog?: ActivityEntry[] } | null) => {
        if (d?.activityLog) setActivity(d.activityLog)
      })
      .catch(() => {/* non-fatal */})
  }, [lead.id])

  async function generateOutreach() {
    setOutLoading(true)
    try {
      const res = await fetch(`/api/sales/outreach/${lead.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, cardId }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { draft: OutreachDraft }
      setOutreach(data.draft)
    } catch (e) {
      console.warn('[LeadPanel] outreach error:', e)
    } finally {
      setOutLoading(false)
    }
  }

  async function submitForApproval() {
    if (!outreach) return
    setSubmitLoading(true)
    try {
      const res = await fetch(`/api/sales/submit/${lead.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, draft: outreach }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { holdQueueId?: string }
      setHoldId(data.holdQueueId ?? 'submitted')
      onLeadUpdate({ ...lead, status: 'contacted' })
    } catch (e) {
      console.warn('[LeadPanel] submit error:', e)
    } finally {
      setSubmitLoading(false)
    }
  }

  async function runDealReview() {
    setReviewLoading(true)
    try {
      const res = await fetch(`/api/sales/review/${lead.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, cardId }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { review: DealReview }
      setReview(data.review)
    } catch (e) {
      console.warn('[LeadPanel] review error:', e)
    } finally {
      setReviewLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 420,
      background: 'var(--surface)', borderLeft: '1px solid var(--line-2)',
      zIndex: 100, display: 'flex', flexDirection: 'column',
      boxShadow: '-4px 0 24px #00000066',
    }}>
      {/* Header */}
      <div style={{
        padding: '1rem 1.25rem', borderBottom: '1px solid var(--line-2)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--fg)' }}>{lead.name}</div>
          {lead.company && <div style={{ fontSize: '0.8rem', color: 'var(--fg-2)', marginTop: 2 }}>{lead.company}</div>}
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: 'var(--fg-2)',
          fontSize: '1.2rem', cursor: 'pointer', padding: '0 0.25rem',
        }}>✕</button>
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem' }}>
        {/* Score + tier */}
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
          <ScoreBadge score={lead.score} />
          <TierBadge tier={lead.tier} />
          <span style={{ fontSize: '0.78rem', color: 'var(--fg-2)', marginLeft: 'auto' }}>
            {lead.status}
          </span>
        </div>

        {/* Deal review */}
        {review && (
          <div style={{
            background: 'var(--bg)',
            border: `1px solid ${HEALTH_COLOR[review.dealHealth] ?? 'var(--line-2)'}`,
            borderRadius: 6, padding: '0.75rem', marginBottom: '1rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--fg-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Deal Review
              </span>
              <span style={{ marginLeft: 'auto', color: HEALTH_COLOR[review.dealHealth], fontWeight: 700, fontSize: '0.8rem', textTransform: 'capitalize' }}>
                {review.dealHealth}
              </span>
              <span style={{ fontSize: '0.78rem', color: 'var(--fg-2)' }}>
                P(close) {review.probabilityToClose}%
              </span>
            </div>
            {review.positiveSignals.length > 0 && (
              <div style={{ marginBottom: '0.4rem' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--ok)', fontWeight: 600 }}>Positive</div>
                {review.positiveSignals.map((s, i) => (
                  <div key={i} style={{ fontSize: '0.78rem', color: 'var(--fg-2)' }}>✓ {s}</div>
                ))}
              </div>
            )}
            {review.redFlags.length > 0 && (
              <div style={{ marginBottom: '0.4rem' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--bad)', fontWeight: 600 }}>Red flags</div>
                {review.redFlags.map((s, i) => (
                  <div key={i} style={{ fontSize: '0.78rem', color: 'var(--fg-2)' }}>⚠ {s}</div>
                ))}
              </div>
            )}
            {review.recommendedActions.length > 0 && (
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--info)', fontWeight: 600 }}>Next actions</div>
                {review.recommendedActions.map((s, i) => (
                  <div key={i} style={{ fontSize: '0.78rem', color: 'var(--fg-2)' }}>→ {s}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Website */}
        {lead.website && (
          <div style={{ marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--fg-2)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Website</span>
            <div style={{ marginTop: 2 }}>
              <a href={lead.website} target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--info)', fontSize: '0.875rem', wordBreak: 'break-all' }}>
                {lead.website}
              </a>
            </div>
          </div>
        )}

        {/* Activity log */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{
            fontSize: '0.75rem', color: 'var(--fg-2)', textTransform: 'uppercase',
            letterSpacing: '0.04em', marginBottom: '0.5rem',
          }}>
            Activity Log
          </div>
          <div style={{
            maxHeight: 180, overflowY: 'auto', background: 'var(--bg)',
            borderRadius: 6, border: '1px solid var(--line-2)', padding: '0.5rem 0.75rem',
          }}>
            {activity.length === 0 && (
              <div style={{ color: 'var(--fg-2)', fontSize: '0.8rem' }}>No activity yet.</div>
            )}
            {activity.map((a, i) => (
              <div key={i} style={{
                paddingBottom: '0.4rem', marginBottom: '0.4rem',
                borderBottom: i < activity.length - 1 ? '1px solid var(--line-2)' : undefined,
              }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--fg-2)' }}>
                  {new Date(a.timestamp).toLocaleString()}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--fg-2)', marginTop: 1 }}>{a.detail}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Outreach draft */}
        {outreach && (
          <div style={{
            background: 'var(--bg)', border: '1px solid var(--line-2)',
            borderRadius: 6, padding: '0.75rem', marginBottom: '1rem',
          }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--fg-2)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Outreach Draft
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--violet)', fontWeight: 600, marginBottom: '0.35rem' }}>
              {outreach.subjectLine}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--fg-2)', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>
              {outreach.emailBody}
            </div>
            {outreach.linkedinMessage && (
              <div style={{ marginTop: '0.6rem' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--info)', fontWeight: 600, marginBottom: 2 }}>LinkedIn</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>{outreach.linkedinMessage}</div>
              </div>
            )}
            {outreach.callScript && (
              <div style={{ marginTop: '0.6rem' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--violet)', fontWeight: 600, marginBottom: 2 }}>Call script</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--fg-2)', whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>{outreach.callScript}</div>
              </div>
            )}
          </div>
        )}

        {holdId && (
          <div style={{
            background: '#22543d22', border: '1px solid #22543d',
            borderRadius: 6, padding: '0.6rem 0.75rem', marginBottom: '1rem',
            fontSize: '0.82rem', color: 'var(--ok)',
          }}>
            Submitted to hold queue: <strong>{holdId}</strong>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div style={{
        padding: '1rem 1.25rem', borderTop: '1px solid var(--line-2)',
        display: 'flex', gap: '0.75rem', flexWrap: 'wrap',
      }}>
        <button
          onClick={runDealReview}
          disabled={reviewLoading}
          style={{
            flex: '1 1 100%', background: reviewLoading ? 'var(--line-2)' : '#553c9a',
            color: '#e9d8fd', border: 'none', borderRadius: 6,
            padding: '0.5rem', fontSize: '0.85rem', cursor: reviewLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {reviewLoading ? 'Reviewing…' : 'Review Deal Health'}
        </button>
        <button
          onClick={generateOutreach}
          disabled={outLoading}
          style={{
            flex: 1, background: outLoading ? 'var(--line-2)' : '#2c5282',
            color: '#bee3f8', border: 'none', borderRadius: 6,
            padding: '0.5rem', fontSize: '0.85rem', cursor: outLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {outLoading ? 'Generating…' : 'Generate Outreach'}
        </button>
        {outreach && !holdId && (
          <button
            onClick={submitForApproval}
            disabled={submitLoading}
            style={{
              flex: 1, background: submitLoading ? 'var(--line-2)' : '#276749',
              color: '#9ae6b4', border: 'none', borderRadius: 6,
              padding: '0.5rem', fontSize: '0.85rem', cursor: submitLoading ? 'not-allowed' : 'pointer',
            }}
          >
            {submitLoading ? 'Submitting…' : 'Submit for Approval'}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Kanban column
// ---------------------------------------------------------------------------

interface ColumnProps {
  col: typeof COLUMNS[number]
  leads: LeadRow[]
  onView: (lead: LeadRow) => void
  onMove: (leadId: string, status: LeadRow['status']) => void
}

function KanbanColumn({ col, leads, onView, onMove }: ColumnProps) {
  const nextStatuses = COLUMNS
    .filter((c) => c.key !== col.key)
    .map((c) => c)

  return (
    <div style={{
      flex: '1 1 0', minWidth: 180, background: 'var(--surface)',
      border: '1px solid var(--line-2)', borderRadius: 10,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Column header */}
      <div style={{
        padding: '0.65rem 0.85rem', background: 'var(--bg)',
        borderBottom: '1px solid var(--line-2)', display: 'flex',
        alignItems: 'center', gap: '0.4rem',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          display: 'inline-block', background: col.color, flexShrink: 0,
        }} />
        <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--fg)' }}>{col.label}</span>
        <span style={{
          marginLeft: 'auto', background: 'var(--line-2)', color: 'var(--fg-2)',
          borderRadius: 10, padding: '1px 7px', fontSize: '0.72rem',
        }}>
          {leads.length}
        </span>
      </div>

      {/* Cards */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
        {leads.map((lead) => (
          <div key={lead.id} style={{
            background: 'var(--bg)', border: '1px solid var(--line-2)',
            borderRadius: 8, padding: '0.65rem 0.75rem', marginBottom: '0.5rem',
          }}>
            <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--fg)', marginBottom: 2 }}>
              {lead.name}
            </div>
            {lead.company && (
              <div style={{ fontSize: '0.78rem', color: 'var(--fg-2)', marginBottom: '0.4rem' }}>
                {lead.company}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
              <ScoreBadge score={lead.score} />
              <TierBadge tier={lead.tier} />
            </div>

            {/* Move + View actions */}
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
              <button
                onClick={() => onView(lead)}
                style={{
                  background: 'var(--line-2)', color: 'var(--fg-2)',
                  border: 'none', borderRadius: 4, padding: '0.25rem 0.6rem',
                  fontSize: '0.75rem', cursor: 'pointer',
                }}
              >
                View
              </button>
              <div style={{ position: 'relative' }}>
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) onMove(lead.id, e.target.value as LeadRow['status'])
                    e.target.value = ''
                  }}
                  style={{
                    background: 'var(--surface)', color: 'var(--fg-2)',
                    border: '1px solid var(--line-2)', borderRadius: 4,
                    padding: '0.2rem 0.4rem', fontSize: '0.72rem', cursor: 'pointer',
                  }}
                >
                  <option value="" disabled>→ Move</option>
                  {nextStatuses.map((s) => (
                    <option key={s.key} value={s.key}>→ {s.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        ))}
        {leads.length === 0 && (
          <div style={{ color: 'var(--line-2)', fontSize: '0.78rem', textAlign: 'center', padding: '1rem 0' }}>
            Empty
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SalesPipelinePage() {
  const { currentCompany } = useHelixStore()
  const [leads, setLeads]         = useState<LeadRow[]>([])
  const [loading, setLoading]     = useState(false)
  const [qualifying, setQualifying] = useState(false)
  const [panelLead, setPanelLead] = useState<LeadRow | null>(null)

  const loadLeads = useCallback(async (companyId: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/sales/leads/${companyId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { leads: LeadRow[] }
      setLeads(data.leads ?? [])
    } catch (e) {
      console.warn('[SalesPipelinePage] load error:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (currentCompany) loadLeads(currentCompany.id)
    else setLeads([])
  }, [currentCompany, loadLeads])

  async function handleMove(leadId: string, status: LeadRow['status']) {
    try {
      const res = await fetch(`/api/sales/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { lead: LeadRow }
      setLeads((prev) => prev.map((l) => l.id === leadId ? data.lead : l))
      if (panelLead?.id === leadId) setPanelLead(data.lead)
    } catch (e) {
      console.warn('[SalesPipelinePage] move error:', e)
    }
  }

  function handleLeadUpdate(updated: LeadRow) {
    setLeads((prev) => prev.map((l) => l.id === updated.id ? updated : l))
    if (panelLead?.id === updated.id) setPanelLead(updated)
  }

  async function qualifyAll() {
    setQualifying(true)
    try {
      const res = await fetch(`/api/sales/qualify/bulk/${currentCompany!.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: currentCompany!.id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { leads: LeadRow[] }
      setLeads(data.leads ?? [])
    } catch (e) {
      console.warn('[SalesPipelinePage] bulk qualify error:', e)
    } finally {
      setQualifying(false)
    }
  }

  if (!currentCompany) {
    return (
      <div style={{ color: 'var(--fg-2)', padding: '2rem', textAlign: 'center' }}>
        Select a company from the header to view the pipeline.
      </div>
    )
  }

  const byStatus = (status: LeadRow['status']) =>
    leads.filter((l) => l.status === status)

  return (
    <div style={{ color: 'var(--fg)', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--fg)', margin: 0 }}>
          Sales Pipeline
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--fg-2)' }}>
            {leads.length} total leads
          </span>
          <button
            onClick={qualifyAll}
            disabled={qualifying || leads.length === 0}
            style={{
              background: (qualifying || leads.length === 0) ? 'var(--line-2)' : '#2c5282',
              color: '#bee3f8', border: 'none',
              borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.8rem',
              cursor: (qualifying || leads.length === 0) ? 'not-allowed' : 'pointer',
            }}
          >
            {qualifying ? 'Qualifying…' : '⚡ Qualify All'}
          </button>
          <button
            onClick={() => loadLeads(currentCompany.id)}
            disabled={loading}
            style={{
              background: 'var(--line-2)', color: 'var(--fg-2)', border: 'none',
              borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.8rem',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Loading…' : '↺ Refresh'}
          </button>
        </div>
      </div>

      {/* Kanban board */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', overflowX: 'auto', paddingBottom: '1rem' }}>
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.key}
            col={col}
            leads={byStatus(col.key)}
            onView={setPanelLead}
            onMove={handleMove}
          />
        ))}
      </div>

      {/* Side panel */}
      {panelLead && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setPanelLead(null)}
            style={{
              position: 'fixed', inset: 0, background: '#00000066', zIndex: 99,
            }}
          />
          <LeadPanel
            lead={panelLead}
            companyId={currentCompany.id}
            cardId={currentCompany.id}
            onClose={() => setPanelLead(null)}
            onLeadUpdate={handleLeadUpdate}
          />
        </>
      )}
    </div>
  )
}
