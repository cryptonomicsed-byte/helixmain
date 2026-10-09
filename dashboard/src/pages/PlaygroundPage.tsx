import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { PlaygroundSession, PlaygroundMessage, TestResult, Company } from '../api'

// ---------------------------------------------------------------------------
// CSS injected once into the document head
// ---------------------------------------------------------------------------

const STYLES = `
.playground{display:flex;gap:1.5rem;height:calc(100vh - 120px)}
.play-sidebar{width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:1rem}
.play-sidebar select,.play-sidebar button{width:100%;box-sizing:border-box}
.play-chat{flex:1;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.play-messages{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.75rem}
.play-messages-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.875rem}
.msg-customer{align-self:flex-end;background:#1e40af;color:#fff;padding:.6rem .9rem;border-radius:12px 12px 2px 12px;max-width:70%}
.msg-agent{align-self:flex-start;background:var(--surface);border:1px solid var(--border);padding:.6rem .9rem;border-radius:12px 12px 12px 2px;max-width:75%}
.msg-text{font-size:.875rem;line-height:1.5;white-space:pre-wrap}
.msg-meta{font-size:.72rem;color:var(--muted);margin-top:.3rem}
.gate-warn{color:#f59e0b;font-size:.72rem;margin-top:.2rem}
.play-input{display:flex;gap:.5rem;padding:1rem;border-top:1px solid var(--border)}
.play-input input{flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:.5rem .75rem;border-radius:6px;font-size:.875rem}
.play-input input:focus{outline:none;border-color:var(--accent)}
.play-input input:disabled{opacity:.5}
.test-result{display:flex;align-items:flex-start;gap:.5rem;font-size:.82rem;padding:.35rem 0;border-bottom:1px solid var(--border)}
.test-result:last-child{border-bottom:none}
.test-pass{color:#22c55e;flex-shrink:0;font-weight:700}
.test-fail{color:#f87171;flex-shrink:0;font-weight:700}
.test-label{color:var(--text);font-weight:500}
.test-detail{color:var(--muted);font-size:.75rem;margin-top:.15rem;line-height:1.4}
.sidebar-label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
.sidebar-section{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.75rem;display:flex;flex-direction:column;gap:.5rem}
.session-badge{font-size:.7rem;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:.15rem .4rem;display:inline-block}
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
  onClick,
  disabled,
  loading,
  danger,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        padding: '.5rem .75rem',
        borderRadius: 6,
        border: danger ? '1px solid #f87171' : '1px solid var(--border)',
        background: danger ? '#7f1d1d22' : 'var(--surface)',
        color: danger ? '#f87171' : 'var(--text)',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        fontSize: '.82rem',
        fontWeight: 600,
        opacity: disabled || loading ? 0.5 : 1,
      }}
    >
      {loading ? '...' : children}
    </button>
  )
}

function MessageBubble({ msg }: { msg: PlaygroundMessage }) {
  const isCustomer = msg.role === 'customer'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isCustomer ? 'flex-end' : 'flex-start' }}>
      <div className={isCustomer ? 'msg-customer' : 'msg-agent'}>
        <div className="msg-text">{msg.content}</div>
      </div>
      {!isCustomer && (
        <>
          {(msg.cardSectionsUsed?.length ?? 0) > 0 && (
            <div className="msg-meta">
              Used: {msg.cardSectionsUsed!.join(', ')}
            </div>
          )}
          {msg.gateTriggered && (
            <div className="gate-warn">
              ⚠ Would trigger approval{msg.gateReason ? ` — ${msg.gateReason}` : ''}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TestResultRow({ result }: { result: TestResult }) {
  return (
    <div className="test-result">
      <span className={result.passed ? 'test-pass' : 'test-fail'}>
        {result.passed ? '✓' : '✗'}
      </span>
      <div>
        <div className="test-label">{result.test}</div>
        <div className="test-detail">{result.detail}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function PlaygroundPage() {
  injectStyles()

  const [companies, setCompanies]       = useState<Company[]>([])
  const [selectedCompany, setSelectedCompany] = useState('')
  const [selectedCard, setSelectedCard] = useState('')
  const [persona, setPersona]           = useState(PERSONAS[0])
  const [session, setSession]           = useState<PlaygroundSession | null>(null)
  const [input, setInput]               = useState('')
  const [starting, setStarting]         = useState(false)
  const [sending, setSending]           = useState(false)
  const [testing, setTesting]           = useState(false)
  const [testResults, setTestResults]   = useState<TestResult[]>([])
  const [error, setError]               = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Load company list
  useEffect(() => {
    api.listCompanies()
      .then((list) => {
        setCompanies(list)
        if (list.length > 0) {
          setSelectedCompany(list[0].id)
          setSelectedCard(list[0].id)
        }
      })
      .catch(() => setError('Could not load companies'))
  }, [])

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages])

  async function startSession() {
    if (!selectedCompany || !selectedCard) return
    setStarting(true)
    setError(null)
    setTestResults([])
    try {
      const s = await api.playgroundCreate(selectedCompany, selectedCard, persona)
      setSession(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session')
    } finally {
      setStarting(false)
    }
  }

  async function sendChat() {
    if (!session || !input.trim() || sending) return
    const text = input.trim()
    setInput('')
    setSending(true)
    setError(null)

    // Optimistic customer bubble
    const optimisticMsg: PlaygroundMessage = {
      id: `opt_${Date.now()}`,
      role: 'customer',
      content: text,
      timestamp: new Date().toISOString(),
    }
    setSession((s) => s ? { ...s, messages: [...s.messages, optimisticMsg] } : s)

    try {
      const reply = await api.playgroundMessage(session.id, text)
      // Replace optimistic + append real agent reply
      setSession((s) => {
        if (!s) return s
        const without = s.messages.filter((m) => m.id !== optimisticMsg.id)
        const customerMsg: PlaygroundMessage = { ...optimisticMsg, id: `c_${Date.now()}` }
        return { ...s, messages: [...without, customerMsg, reply] }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed')
      // Remove optimistic bubble on error
      setSession((s) => s ? { ...s, messages: s.messages.filter((m) => m.id !== optimisticMsg.id) } : s)
    } finally {
      setSending(false)
    }
  }

  async function runTests() {
    if (!session || testing) return
    setTesting(true)
    setError(null)
    setTestResults([])
    try {
      const { results } = await api.playgroundTest(session.id)
      setTestResults(results)
      setSession((s) => s ? { ...s, testResults: results } : s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test suite failed')
    } finally {
      setTesting(false)
    }
  }

  async function clearCurrentSession() {
    if (!session) return
    await api.playgroundClear(session.id).catch(() => null)
    setSession(null)
    setTestResults([])
    setError(null)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendChat()
    }
  }

  const passCount = testResults.filter((r) => r.passed).length

  return (
    <div>
      <div style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#f1f5f9', margin: 0 }}>
          Agent Playground
        </h1>
        <p style={{ color: '#64748b', fontSize: '0.875rem', marginTop: '0.35rem' }}>
          Test your agent before going live — inspect routing, gates, and tone.
        </p>
      </div>

      {error && (
        <div style={{
          background: '#7f1d1d22', border: '1px solid #f87171', borderRadius: 6,
          padding: '.5rem .75rem', color: '#f87171', fontSize: '.82rem', marginBottom: '1rem',
        }}>
          {error}
        </div>
      )}

      <div className="playground">
        {/* ---------------------------------------------------------------- */}
        {/* LEFT SIDEBAR                                                      */}
        {/* ---------------------------------------------------------------- */}
        <div className="play-sidebar">

          {/* Company + persona selectors */}
          <div className="sidebar-section">
            <SectionHeader>Business</SectionHeader>
            <select
              value={selectedCompany}
              onChange={(e) => { setSelectedCompany(e.target.value); setSelectedCard(e.target.value) }}
              disabled={!!session}
              style={{
                background: 'var(--bg)', border: '1px solid var(--border)',
                color: 'var(--text)', padding: '.4rem .5rem', borderRadius: 6, fontSize: '.82rem',
              }}
            >
              {companies.length === 0 && <option value="">Loading...</option>}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            <SectionHeader>Persona</SectionHeader>
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              disabled={!!session}
              style={{
                background: 'var(--bg)', border: '1px solid var(--border)',
                color: 'var(--text)', padding: '.4rem .5rem', borderRadius: 6, fontSize: '.82rem',
              }}
            >
              {PERSONAS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>

            {!session ? (
              <Btn onClick={startSession} loading={starting} disabled={companies.length === 0}>
                Start Session
              </Btn>
            ) : (
              <Btn onClick={clearCurrentSession} danger>
                Clear Session
              </Btn>
            )}

            {session && (
              <span className="session-badge">
                Session {session.id.slice(0, 12)}… · v{session.cardVersion}
              </span>
            )}
          </div>

          {/* Test suite */}
          <div className="sidebar-section">
            <SectionHeader>Automated Tests</SectionHeader>
            <Btn
              onClick={runTests}
              loading={testing}
              disabled={!session}
            >
              {testing ? 'Running…' : 'Run All Tests'}
            </Btn>

            {testResults.length > 0 && (
              <div style={{ fontSize: '.75rem', color: '#64748b', marginBottom: '.25rem' }}>
                {passCount}/{testResults.length} passed
              </div>
            )}

            {testResults.map((r, i) => (
              <TestResultRow key={i} result={r} />
            ))}

            {testResults.length === 0 && !testing && (
              <div style={{ fontSize: '.75rem', color: 'var(--muted)', textAlign: 'center', padding: '.5rem 0' }}>
                No results yet
              </div>
            )}
          </div>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* RIGHT: CHAT PANEL                                                 */}
        {/* ---------------------------------------------------------------- */}
        <div className="play-chat">
          {/* Message thread */}
          <div className="play-messages">
            {!session && (
              <div className="play-messages-empty">
                Select a business and start a session to begin.
              </div>
            )}

            {session && session.messages.length === 0 && (
              <div className="play-messages-empty">
                Send a message to begin the conversation.
              </div>
            )}

            {session?.messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}

            {sending && (
              <div className="msg-agent" style={{ alignSelf: 'flex-start', opacity: 0.6 }}>
                <div className="msg-text" style={{ color: 'var(--muted)' }}>Thinking…</div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="play-input">
            <input
              type="text"
              placeholder={session ? 'Type a customer message…' : 'Start a session first'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={!session || sending}
            />
            <Btn
              onClick={sendChat}
              disabled={!session || !input.trim()}
              loading={sending}
            >
              Send
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}
