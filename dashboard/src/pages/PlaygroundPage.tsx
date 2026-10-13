import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useCard } from './card/CardContext'
import type { PlaygroundSession, PlaygroundMessage, TestResult } from '../api'

// ---------------------------------------------------------------------------
// CSS injected once into the document head
// ---------------------------------------------------------------------------

const STYLES = `
.playground{display:flex;gap:1.5rem;height:calc(100vh - 220px);min-height:420px}
.play-sidebar{width:290px;flex-shrink:0;display:flex;flex-direction:column;gap:1rem;overflow-y:auto}
.play-sidebar select,.play-sidebar button{width:100%;box-sizing:border-box}
.play-chat{flex:1;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.play-messages{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.75rem}
.play-messages-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.875rem}
.msg-customer{align-self:flex-end;background:#1e40af;color:#fff;padding:.6rem .9rem;border-radius:12px 12px 2px 12px;max-width:70%}
.msg-agent{align-self:flex-start;background:var(--surface);border:1px solid var(--border);padding:.6rem .9rem;border-radius:12px 12px 12px 2px;max-width:75%}
.msg-text{font-size:.875rem;line-height:1.5;white-space:pre-wrap}
.msg-meta{font-size:.72rem;color:var(--muted);margin-top:.3rem}
.gate-warn{color:var(--warn);font-size:.72rem;margin-top:.2rem}
.play-input{display:flex;gap:.5rem;padding:1rem;border-top:1px solid var(--border)}
.play-input input{flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:.5rem .75rem;border-radius:6px;font-size:.875rem}
.play-input input:focus{outline:none;border-color:var(--accent)}
.play-input input:disabled{opacity:.5}
.test-result{display:flex;align-items:flex-start;gap:.5rem;font-size:.82rem;padding:.35rem 0;border-bottom:1px solid var(--border)}
.test-result:last-child{border-bottom:none}
.test-pass{color:var(--ok);flex-shrink:0;font-weight:700}
.test-fail{color:var(--bad);flex-shrink:0;font-weight:700}
.test-label{color:var(--text);font-weight:500}
.test-detail{color:var(--muted);font-size:.75rem;margin-top:.15rem;line-height:1.4}
.sidebar-label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
.sidebar-section{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.75rem;display:flex;flex-direction:column;gap:.5rem}
.session-badge{font-size:.7rem;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:.15rem .4rem;display:inline-block}
.chip{display:block;width:100%;text-align:left;font-size:.78rem;padding:.4rem .55rem;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer}
.chip:hover{border-color:var(--accent);color:var(--fg)}
.chip:disabled{opacity:.45;cursor:not-allowed}
.past-item{display:flex;justify-content:space-between;gap:.4rem;align-items:center;font-size:.74rem;padding:.3rem .1rem;border-bottom:1px solid var(--border)}
.past-item:last-child{border-bottom:none}
.past-item button{width:auto}
`

function injectStyles() {
  if (document.getElementById('playground-styles')) return
  const el = document.createElement('style')
  el.id = 'playground-styles'
  el.textContent = STYLES
  document.head.appendChild(el)
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const PERSONAS = ['Customer', 'Difficult Customer', 'Curious Shopper', 'Repeat Customer']

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <div className="sidebar-label">{children}</div>
}

function Btn({
  onClick, disabled, loading, danger, title, children,
}: {
  onClick: () => void; disabled?: boolean; loading?: boolean; danger?: boolean
  title?: string; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick} disabled={disabled || loading} title={title}
      style={{
        padding: '.5rem .75rem', borderRadius: 6,
        border: danger ? '1px solid var(--bad)' : '1px solid var(--border)',
        background: danger ? '#7f1d1d22' : 'var(--surface)',
        color: danger ? 'var(--bad)' : 'var(--text)',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        fontSize: '.82rem', fontWeight: 600, opacity: disabled || loading ? 0.5 : 1,
      }}
    >
      {loading ? '...' : children}
    </button>
  )
}

function MessageBubble({ msg, latencyMs }: { msg: PlaygroundMessage; latencyMs?: number }) {
  const isCustomer = msg.role === 'customer'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isCustomer ? 'flex-end' : 'flex-start' }}>
      <div className={isCustomer ? 'msg-customer' : 'msg-agent'}>
        <div className="msg-text">{msg.content}</div>
      </div>
      {!isCustomer && (
        <>
          <div className="msg-meta">
            {typeof latencyMs === 'number' && <>{latencyMs} ms</>}
            {(msg.cardSectionsUsed?.length ?? 0) > 0 && (
              <>{(typeof latencyMs === 'number' ? ' · ' : '')}Used: {msg.cardSectionsUsed!.join(', ')}</>
            )}
          </div>
          {msg.gateTriggered && (
            <div className="gate-warn">⚠ Would trigger approval{msg.gateReason ? ` — ${msg.gateReason}` : ''}</div>
          )}
        </>
      )}
    </div>
  )
}

function TestResultRow({ result }: { result: TestResult }) {
  return (
    <div className="test-result">
      <span className={result.passed ? 'test-pass' : 'test-fail'}>{result.passed ? '✓' : '✗'}</span>
      <div>
        <div className="test-label">{result.test}</div>
        <div className="test-detail">{result.detail}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page — card-bound: the business/card IS the one you are looking at.
// ---------------------------------------------------------------------------

export function PlaygroundPage() {
  injectStyles()

  const { id: cardId, card } = useCard() as { id: string; card: any }

  const [persona, setPersona]           = useState(PERSONAS[0])
  const [session, setSession]           = useState<PlaygroundSession | null>(null)
  const [past, setPast]                 = useState<PlaygroundSession[]>([])
  const [input, setInput]               = useState('')
  const [starting, setStarting]         = useState(false)
  const [sending, setSending]           = useState(false)
  const [testing, setTesting]           = useState(false)
  const [testResults, setTestResults]   = useState<TestResult[]>([])
  const [latency, setLatency]           = useState<Record<string, number>>({})
  const [error, setError]               = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Starter prompts grounded in THIS card, so the playground is useful at once.
  const suggestions = useMemo(() => {
    const out: string[] = []
    if (card?.hours?.value) out.push('What are your opening hours?')
    if (card?.phone?.value) out.push('What is your phone number?')
    for (const o of (card?.offerings?.items ?? []).slice(0, 4)) out.push(`Tell me about ${o}`)
    if (out.length === 0) out.push('What do you offer?', 'Where are you located?')
    return out.slice(0, 6)
  }, [card])

  const refreshPast = useCallback(() => {
    if (!cardId) return
    api.playgroundSessions(cardId).then((list) => setPast(Array.isArray(list) ? list : [])).catch(() => setPast([]))
  }, [cardId])

  useEffect(() => { refreshPast() }, [refreshPast])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages.length, sending])

  async function startSession() {
    if (!cardId || starting) return
    setStarting(true); setError(null); setTestResults([]); setLatency({})
    try {
      setSession(await api.playgroundCreate(cardId, cardId, persona))
      refreshPast()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session')
    } finally { setStarting(false) }
  }

  async function sendChat(prefill?: string) {
    const text = (prefill ?? input).trim()
    if (!session || !text || sending) return
    setInput(''); setSending(true); setError(null)

    const optimisticMsg: PlaygroundMessage = {
      id: `opt_${Date.now()}`, role: 'customer', content: text, timestamp: new Date().toISOString(),
    }
    setSession((s) => s ? { ...s, messages: [...s.messages, optimisticMsg] } : s)

    const t0 = performance.now()
    try {
      // companyId is the billing principal. Without it the API bills "default"
      // (body.companyId ?? "default"), an account with no credits → 402.
      const reply = await api.playgroundMessage(session.id, text, cardId)
      const ms = Math.round(performance.now() - t0)
      setSession((s) => {
        if (!s) return s
        const without = s.messages.filter((m) => m.id !== optimisticMsg.id)
        const customerMsg: PlaygroundMessage = { ...optimisticMsg, id: `c_${Date.now()}` }
        return { ...s, messages: [...without, customerMsg, reply] }
      })
      setLatency((l) => ({ ...l, [reply.id]: ms }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed')
      setSession((s) => s ? { ...s, messages: s.messages.filter((m) => m.id !== optimisticMsg.id) } : s)
    } finally { setSending(false) }
  }

  async function runTests() {
    if (!session || testing) return
    setTesting(true); setError(null); setTestResults([])
    try {
      const { results } = await api.playgroundTest(session.id)
      setTestResults(results)
      setSession((s) => s ? { ...s, testResults: results } : s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test suite failed')
    } finally { setTesting(false) }
  }

  async function clearCurrentSession() {
    if (!session) return
    await api.playgroundClear(session.id).catch(() => null)
    setSession(null); setTestResults([]); setLatency({}); setError(null)
    refreshPast()
  }

  function resumePast(s: PlaygroundSession) {
    setSession(s); setTestResults(s.testResults ?? []); setLatency({}); setError(null)
  }

  function exportTranscript() {
    if (!session) return
    const lines = [
      `# Playground transcript — ${cardId}`,
      `Persona: ${session.persona ?? persona}`,
      `Session: ${session.id}  ·  card v${session.cardVersion}`,
      '',
    ]
    for (const m of session.messages) {
      lines.push(`**${m.role}:** ${m.content}`)
      if (m.cardSectionsUsed?.length) lines.push(`_used: ${m.cardSectionsUsed.join(', ')}_`)
      if (m.gateTriggered) lines.push(`_gate: ${m.gateReason || 'would require approval'}_`)
      lines.push('')
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `playground-${cardId}.md`; a.click()
    URL.revokeObjectURL(url)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
  }

  const passCount = testResults.filter((r) => r.passed).length

  return (
    <div>
      {error && (
        <div style={{
          background: '#7f1d1d22', border: '1px solid var(--bad)', borderRadius: 6,
          padding: '.5rem .75rem', color: 'var(--bad)', fontSize: '.82rem', marginBottom: '1rem',
        }}>
          {error}
        </div>
      )}

      <div className="playground">
        {/* ── LEFT SIDEBAR ─────────────────────────────────────────────── */}
        <div className="play-sidebar">
          <div className="sidebar-section">
            <SectionHeader>Session</SectionHeader>
            <select value={persona} onChange={(e) => setPersona(e.target.value)} disabled={!!session}
              style={{
                background: 'var(--bg)', border: '1px solid var(--border)',
                color: 'var(--text)', padding: '.4rem .5rem', borderRadius: 6, fontSize: '.82rem',
              }}>
              {PERSONAS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>

            {!session ? (
              <Btn onClick={startSession} loading={starting} disabled={!cardId}>Start Session</Btn>
            ) : (
              <>
                <Btn onClick={clearCurrentSession} danger>Clear Session</Btn>
                <Btn onClick={exportTranscript}>↓ Export transcript</Btn>
              </>
            )}

            {session && (
              <span className="session-badge">Session {session.id.slice(0, 12)}… · v{session.cardVersion}</span>
            )}
          </div>

          <div className="sidebar-section">
            <SectionHeader>Suggested prompts</SectionHeader>
            {suggestions.map((s) => (
              <button key={s} className="chip" disabled={!session || sending}
                onClick={() => sendChat(s)} title={session ? undefined : 'Start a session first'}>
                {s}
              </button>
            ))}
          </div>

          <div className="sidebar-section">
            <SectionHeader>Automated Tests</SectionHeader>
            <Btn onClick={runTests} loading={testing} disabled={!session}>
              {testing ? 'Running…' : 'Run All Tests'}
            </Btn>
            {testResults.length > 0 && (
              <div style={{ fontSize: '.75rem', color: 'var(--fg-3)' }}>{passCount}/{testResults.length} passed</div>
            )}
            {testResults.map((r, i) => <TestResultRow key={i} result={r} />)}
            {testResults.length === 0 && !testing && (
              <div style={{ fontSize: '.75rem', color: 'var(--muted)', textAlign: 'center', padding: '.5rem 0' }}>
                No results yet
              </div>
            )}
          </div>

          {past.length > 0 && (
            <div className="sidebar-section">
              <SectionHeader>Recent sessions ({past.length})</SectionHeader>
              {past.slice(0, 6).map((s) => (
                <div key={s.id} className="past-item">
                  <span className="mono" style={{ color: 'var(--muted)' }}>{s.id.slice(0, 10)}…</span>
                  <span style={{ color: 'var(--muted)' }}>{s.messages.length} msg</span>
                  <button className="chip" style={{ width: 'auto' }} onClick={() => resumePast(s)}>open</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── RIGHT: CHAT PANEL ────────────────────────────────────────── */}
        <div className="play-chat">
          <div className="play-messages">
            {!session && (
              <div className="play-messages-empty">
                Start a session to test this card's agent.
              </div>
            )}
            {session && session.messages.length === 0 && (
              <div className="play-messages-empty">Send a message — or pick a suggested prompt.</div>
            )}
            {session?.messages.map((msg) => <MessageBubble key={msg.id} msg={msg} latencyMs={latency[msg.id]} />)}
            {sending && (
              <div className="msg-agent" style={{ alignSelf: 'flex-start', opacity: 0.6 }}>
                <div className="msg-text" style={{ color: 'var(--muted)' }}>Thinking…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="play-input">
            <input
              type="text"
              placeholder={session ? 'Type a customer message…' : 'Start a session first'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={!session || sending}
            />
            <Btn onClick={() => sendChat()} disabled={!session || !input.trim()} loading={sending}>Send</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
