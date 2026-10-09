import { useState } from 'react'
import { useHelixStore } from '../store'

// ---------------------------------------------------------------------------
// Types (matching actual BattleReport shape from intelEngine.ts)
// ---------------------------------------------------------------------------

interface ScoreSection {
  winner: string
  score: number
  analysis: string
}

interface BattleReport {
  companyA: string
  companyB: string
  visual: ScoreSection
  messaging: ScoreSection
  positioning: ScoreSection
  overall: { winner: string; recommendation: string }
  gaps: string[]
  generatedAt: string
  appendixOnly: true
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScoreBar({ label, score, winner }: { label: string; score: number; winner: string }) {
  const pct = Math.max(0, Math.min(100, score))
  const barColor = pct >= 70 ? '#68d391' : pct >= 40 ? '#f6ad55' : '#fc8181'

  return (
    <div style={{ marginBottom: '0.85rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
        <span style={{ fontSize: '0.82rem', color: '#a0aec0' }}>{label}</span>
        <span style={{ fontSize: '0.78rem', color: '#718096' }}>
          {pct}/100 · winner: <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{winner}</span>
        </span>
      </div>
      <div style={{ height: 6, background: '#2d3748', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: barColor, borderRadius: 3,
          transition: 'width 0.4s ease',
        }} />
      </div>
    </div>
  )
}

function BulletList({ items, color }: { items: string[]; color: string }) {
  if (!items || items.length === 0) return (
    <div style={{ color: '#718096', fontSize: '0.82rem' }}>None identified.</div>
  )
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {items.map((item, i) => (
        <li key={i} style={{
          display: 'flex', gap: '0.5rem', alignItems: 'flex-start',
          padding: '0.4rem 0', borderBottom: i < items.length - 1 ? '1px solid #2d374855' : undefined,
        }}>
          <span style={{ color, fontSize: '0.85rem', marginTop: 1, flexShrink: 0 }}>•</span>
          <span style={{ fontSize: '0.85rem', color: '#a0aec0', lineHeight: 1.5 }}>{item}</span>
        </li>
      ))}
    </ul>
  )
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: '#1a1f2e', border: '1px solid #2d3748',
      borderRadius: 10, padding: '1.25rem', marginBottom: '1rem',
    }}>
      <div style={{
        fontSize: '0.75rem', color: '#718096', textTransform: 'uppercase',
        letterSpacing: '0.06em', marginBottom: '0.85rem', fontWeight: 600,
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IntelPage() {
  const { currentCompany } = useHelixStore()

  const [competitorId, setCompetitorId] = useState('')
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState('')
  const [report, setReport]             = useState<BattleReport | null>(null)

  const yourName = currentCompany?.name ?? '—'

  async function runBattle() {
    if (!currentCompany) { setError('Select a company first.'); return }
    if (!competitorId.trim()) { setError('Enter a competitor card ID.'); return }
    setError('')
    setLoading(true)
    setReport(null)
    try {
      const res = await fetch('/api/intel/battle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardIdA: currentCompany.id,
          cardIdB: competitorId.trim(),
          companyId: currentCompany.id,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json() as BattleReport
      setReport(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ color: '#e2e8f0', maxWidth: 820 }}>
      {/* Warning banner */}
      <div style={{
        background: '#744210' + '33', border: '1px solid #744210',
        borderRadius: 8, padding: '0.6rem 1rem', marginBottom: '1.5rem',
        display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.85rem', color: '#f6ad55',
      }}>
        <span style={{ fontSize: '1rem' }}>⚠</span>
        Battle reports are for internal use only. Never share with guests.
      </div>

      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1.5rem', color: '#e2e8f0' }}>
        Intel — Battle Mode
      </h1>

      {/* Inputs */}
      <div style={{
        background: '#1a1f2e', border: '1px solid #2d3748',
        borderRadius: 10, padding: '1.5rem', marginBottom: '1.5rem',
      }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {/* Your company */}
          <div style={{ flex: '1 1 200px' }}>
            <div style={{ fontSize: '0.75rem', color: '#718096', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Your Company
            </div>
            <div style={{
              background: '#0f1117', border: '1px solid #2d3748',
              borderRadius: 6, padding: '0.4rem 0.75rem',
              fontSize: '0.875rem', color: '#718096', minHeight: 34,
            }}>
              {currentCompany ? `${yourName} (${currentCompany.id})` : '— select from header —'}
            </div>
          </div>

          {/* Competitor */}
          <div style={{ flex: '1 1 200px' }}>
            <div style={{ fontSize: '0.75rem', color: '#718096', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Competitor Card ID
            </div>
            <input
              type="text"
              value={competitorId}
              onChange={(e) => setCompetitorId(e.target.value)}
              placeholder="e.g. comp_abc123"
              style={{
                width: '100%', background: '#0f1117', border: '1px solid #2d3748',
                color: '#e2e8f0', borderRadius: 6, padding: '0.4rem 0.75rem',
                fontSize: '0.875rem', boxSizing: 'border-box',
              }}
              onKeyDown={(e) => e.key === 'Enter' && runBattle()}
            />
          </div>

          {/* Run button */}
          <button
            onClick={runBattle}
            disabled={loading || !currentCompany}
            style={{
              background: loading || !currentCompany ? '#2d3748' : '#6b46c1',
              color: loading || !currentCompany ? '#718096' : '#e9d8fd',
              border: 'none', borderRadius: 6, padding: '0.45rem 1.5rem',
              fontSize: '0.9rem', fontWeight: 600,
              cursor: loading || !currentCompany ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap', alignSelf: 'flex-end',
            }}
          >
            {loading ? 'Analyzing…' : '⚔ Run Battle'}
          </button>
        </div>

        {error && (
          <div style={{
            marginTop: '0.85rem', background: '#742a2a22', border: '1px solid #742a2a',
            borderRadius: 6, padding: '0.5rem 0.75rem', color: '#fc8181', fontSize: '0.85rem',
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Loading spinner */}
      {loading && (
        <div style={{
          textAlign: 'center', padding: '3rem', color: '#718096', fontSize: '0.95rem',
        }}>
          <div style={{ fontSize: '1.8rem', marginBottom: '0.75rem', animation: 'spin 1s linear infinite' }}>⟳</div>
          Analyzing competitors…
        </div>
      )}

      {/* Report */}
      {report && !loading && (
        <>
          {/* Header */}
          <div style={{
            background: '#1a1f2e', border: '1px solid #2d3748',
            borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1rem',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem',
          }}>
            <div>
              <span style={{ fontWeight: 700, color: '#e2e8f0' }}>{report.companyA}</span>
              <span style={{ color: '#718096', margin: '0 0.5rem' }}>vs</span>
              <span style={{ fontWeight: 700, color: '#e2e8f0' }}>{report.companyB}</span>
            </div>
            <div style={{ fontSize: '0.78rem', color: '#718096' }}>
              Overall winner: <span style={{ color: '#68d391', fontWeight: 700 }}>{report.overall.winner}</span>
            </div>
          </div>

          {/* Score bars */}
          <SectionCard title="Scores">
            <ScoreBar label="Visual Identity"     score={report.visual.score}      winner={report.visual.winner} />
            <ScoreBar label="Messaging Clarity"   score={report.messaging.score}   winner={report.messaging.winner} />
            <ScoreBar label="Positioning Clarity" score={report.positioning.score} winner={report.positioning.winner} />
          </SectionCard>

          {/* Analysis details */}
          <SectionCard title="Analysis">
            {[
              { label: 'Visual',      section: report.visual },
              { label: 'Messaging',   section: report.messaging },
              { label: 'Positioning', section: report.positioning },
            ].map(({ label, section }) => (
              <div key={label} style={{ marginBottom: '0.85rem' }}>
                <div style={{ fontSize: '0.82rem', color: '#9f7aea', fontWeight: 600, marginBottom: '0.2rem' }}>{label}</div>
                <div style={{ fontSize: '0.85rem', color: '#a0aec0', lineHeight: 1.5 }}>{section.analysis}</div>
              </div>
            ))}
          </SectionCard>

          {/* Recommendation */}
          <SectionCard title="Recommendation">
            <div style={{ fontSize: '0.875rem', color: '#a0aec0', lineHeight: 1.6 }}>
              {report.overall.recommendation}
            </div>
          </SectionCard>

          {/* Gaps */}
          <SectionCard title="Gaps — What You're Missing">
            <BulletList items={report.gaps} color="#fc8181" />
          </SectionCard>

          <div style={{ fontSize: '0.72rem', color: '#4a5568', textAlign: 'right', marginTop: '0.5rem' }}>
            Generated {new Date(report.generatedAt).toLocaleString()} · Internal use only
          </div>
        </>
      )}
    </div>
  )
}
