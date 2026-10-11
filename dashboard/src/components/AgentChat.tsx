import { useEffect, useRef, useState } from 'react'
import { agentChat, ApiError } from '../api'
import { Icon } from './Icon'

/**
 * In-card agent chat. The owner talks to THIS company's agent without leaving the
 * card page. Streams deltas as they arrive; shows a thinking indicator; and turns
 * an offline agent into a clear state instead of a spinner that never ends.
 *
 * History is kept per card for the session (sessionStorage), so switching tabs and
 * coming back does not lose the conversation.
 */

type Msg = { role: 'user' | 'agent' | 'error'; text: string }

const storeKey = (id: string) => `helix.agentchat.${id}`

function loadHistory(id: string): Msg[] {
  try {
    const raw = sessionStorage.getItem(storeKey(id))
    return raw ? (JSON.parse(raw) as Msg[]) : []
  } catch {
    return []
  }
}

export function AgentChat({ companyId, name }: { companyId: string; name: string }) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>(() => loadHistory(companyId))
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  // Reload history when the card changes.
  useEffect(() => { setMsgs(loadHistory(companyId)); setOffline(null) }, [companyId])

  // Persist per card.
  useEffect(() => {
    try { sessionStorage.setItem(storeKey(companyId), JSON.stringify(msgs)) } catch { /* quota */ }
  }, [companyId, msgs])

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, busy, open])

  const first = name.split(' ')[0] || companyId

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setOffline(null)
    setBusy(true)
    setMsgs((m) => [...m, { role: 'user', text }, { role: 'agent', text: '' }])

    try {
      // Each chunk appends to the LAST message (the live one).
      await agentChat(companyId, text, (chunk) => {
        setMsgs((m) => {
          const copy = m.slice()
          const last = copy[copy.length - 1]
          if (last && last.role === 'agent') copy[copy.length - 1] = { role: 'agent', text: last.text + chunk }
          return copy
        })
      })
      // Drop an empty agent bubble if the turn produced nothing.
      setMsgs((m) => {
        const copy = m.slice()
        const last = copy[copy.length - 1]
        if (last && last.role === 'agent' && last.text.trim() === '') {
          copy[copy.length - 1] = { role: 'error', text: `${first}'s agent returned nothing.` }
        }
        return copy
      })
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0
      const body = e instanceof ApiError ? e.body : null
      // Offline is a STATE, not a transient failure — surface it and keep it.
      if (status === 503) {
        setOffline(body?.message || `${first}'s agent is offline.`)
      }
      setMsgs((m) => {
        const copy = m.slice()
        // Replace the empty live bubble with the error.
        const last = copy[copy.length - 1]
        const text = e instanceof Error ? e.message : String(e)
        if (last && last.role === 'agent' && last.text.trim() === '') {
          copy[copy.length - 1] = { role: 'error', text }
        } else {
          copy.push({ role: 'error', text })
        }
        return copy
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Launcher — always visible on the card, no navigation needed. */}
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Ask ${name}'s agent`}
        style={{
          position: 'fixed', right: '1.1rem', bottom: '1.1rem', zIndex: 60,
          display: 'inline-flex', alignItems: 'center', gap: '.45rem',
          background: 'var(--brand-2)', color: '#fff', border: 'none',
          borderRadius: 999, padding: '.6rem 1rem', fontSize: '.85rem', fontWeight: 650,
          boxShadow: '0 8px 24px rgba(0,0,0,.35)', cursor: 'pointer',
        }}
      >
        <Icon name="spark" size={15} /> {open ? 'Close' : `Ask ${first}`}
      </button>

      {open && (
        <div
          style={{
            position: 'fixed', right: '1.1rem', bottom: '4.2rem', zIndex: 60,
            width: 'min(400px, calc(100vw - 2.2rem))',
            height: 'min(560px, calc(100vh - 8rem))',
            display: 'flex', flexDirection: 'column',
            background: 'var(--surface)', border: '1px solid var(--line-2)',
            borderRadius: 14, overflow: 'hidden', boxShadow: '0 18px 50px rgba(0,0,0,.45)',
          }}
        >
          <div style={{ padding: '.7rem .9rem', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
            <Icon name="spark" size={14} />
            <div style={{ fontSize: '.85rem', fontWeight: 650 }}>{name}</div>
            <div className="sub" style={{ fontSize: '.72rem', marginLeft: 'auto' }}>
              {offline ? 'offline' : 'card agent'}
            </div>
          </div>

          {offline && (
            <div style={{ margin: '.6rem .9rem 0', padding: '.55rem .7rem', background: '#f59e0b14', border: '1px solid #f59e0b55', borderRadius: 8, fontSize: '.78rem' }}>
              <strong>{first}'s agent is offline.</strong>
              <div className="sub" style={{ fontSize: '.74rem', marginTop: '.2rem' }}>{offline}</div>
            </div>
          )}

          <div ref={scroller} style={{ flex: 1, overflowY: 'auto', padding: '.8rem', display: 'flex', flexDirection: 'column', gap: '.55rem' }}>
            {msgs.length === 0 && !busy && (
              <div className="sub" style={{ fontSize: '.82rem', textAlign: 'center', marginTop: '1.5rem' }}>
                Ask {first} anything — the card is the agent's source of truth.
                <div style={{ marginTop: '.6rem', fontSize: '.76rem', opacity: .8 }}>
                  “What are our opening hours?” · “We're closed Mondays now”
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '88%',
                background: m.role === 'user' ? 'var(--brand-2)' : m.role === 'error' ? '#ef444417' : 'var(--bg)',
                color: m.role === 'user' ? '#fff' : 'var(--fg)',
                border: m.role === 'agent' ? '1px solid var(--line)' : 'none',
                borderRadius: 11, padding: '.5rem .7rem', fontSize: '.84rem',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {m.text || <span style={{ opacity: .5 }}>…</span>}
              </div>
            ))}
            {busy && (
              <div className="sub" style={{ fontSize: '.78rem', display: 'inline-flex', gap: '.4rem', alignItems: 'center' }}>
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: 'var(--brand-2)' }} />
                {first} is thinking…
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--line)', padding: '.6rem', display: 'flex', gap: '.45rem' }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
              placeholder={offline ? 'Agent offline' : `Message ${first}…`}
              disabled={busy}
              style={{
                flex: 1, background: 'var(--bg)', border: '1px solid var(--line-2)', borderRadius: 9,
                color: 'var(--fg)', padding: '.5rem .7rem', fontSize: '.85rem', outline: 'none',
              }}
            />
            <button
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              style={{
                background: busy || !input.trim() ? 'var(--line-2)' : 'var(--brand-2)',
                color: '#fff', border: 'none', borderRadius: 9, padding: '.5rem .85rem',
                fontSize: '.84rem', fontWeight: 650,
                cursor: busy || !input.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  )
}
