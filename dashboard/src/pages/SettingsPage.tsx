import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from '../components/Icon'
import type { SettingsResponse } from '../api'

const PROVIDER_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini',
  groq: 'Groq', openrouter: 'OpenRouter', mistral: 'Mistral',
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,.28)', border: '1px solid var(--line-2)', borderRadius: 10,
  color: 'var(--fg)', padding: '.5rem .7rem', fontSize: '.85rem', width: '100%', outline: 'none',
}

export function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)

  useEffect(() => {
    api.getSettings()
      .then((s) => { setData(s); setProvider(s.provider); setModel(s.model) })
      .catch((e) => setMsg({ kind: 'bad', text: `Could not load settings: ${e instanceof Error ? e.message : e}` }))
  }, [])

  async function saveModel() {
    setBusy(true); setMsg(null)
    try {
      const res = await api.saveSettings({ provider, model })
      setData(res); setMsg({ kind: 'ok', text: 'Model & provider saved.' })
    } catch (e) {
      setMsg({ kind: 'bad', text: `Save failed: ${e instanceof Error ? e.message : e}` })
    } finally { setBusy(false) }
  }

  async function saveKey(p: string) {
    const v = (drafts[p] ?? '').trim()
    if (!v) return
    setBusy(true); setMsg(null)
    try {
      // Also switch the active provider to this one so the key takes effect immediately
      const body: Parameters<typeof api.saveSettings>[0] = { keys: { [p]: v } }
      if (provider !== p) body.provider = p
      const res = await api.saveSettings(body)
      setData(res); setDrafts((d) => ({ ...d, [p]: '' }))
      if (provider !== p) setProvider(p)
      setMsg({ kind: 'ok', text: `${PROVIDER_LABEL[p] ?? p} key saved${provider !== p ? ` and set as active provider.` : '.'}` })
    } catch (e) {
      setMsg({ kind: 'bad', text: `Save failed: ${e instanceof Error ? e.message : e}` })
    } finally { setBusy(false) }
  }

  async function clearKey(p: string) {
    setBusy(true); setMsg(null)
    try {
      const res = await api.saveSettings({ keys: { [p]: '' } })
      setData(res); setMsg({ kind: 'ok', text: `${PROVIDER_LABEL[p] ?? p} key cleared.` })
    } catch (e) {
      setMsg({ kind: 'bad', text: `Clear failed: ${e instanceof Error ? e.message : e}` })
    } finally { setBusy(false) }
  }

  if (!data) {
    return <div className="sub" style={{ padding: '3rem', textAlign: 'center' }}>Loading settings…</div>
  }

  const providerNames = Object.keys(data.providers)
  const modelsForProvider = data.providers[provider]?.models ?? []

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="reveal">
        <div className="h1">Settings</div>
        <div className="sub" style={{ marginTop: 4 }}>
          Choose the model that powers extraction, campaigns and agents — and set provider API keys.
        </div>
      </div>

      {msg && (
        <div className="glass reveal" style={{ padding: '.75rem 1rem', fontSize: '.85rem',
          borderColor: (msg.kind === 'ok' ? 'var(--ok)' : 'var(--bad)') + '55',
          color: msg.kind === 'ok' ? 'var(--ok)' : 'var(--bad)' }}>
          {msg.text}
        </div>
      )}

      {/* Model & provider */}
      <section className="glass reveal reveal-1" style={{ padding: 'var(--pad)' }}>
        <div className="h2" style={{ marginBottom: 4 }}>Model & provider</div>
        <div className="sub" style={{ marginBottom: 14 }}>Applies to every LLM call the API makes.</div>

        <div className="bento">
          <div className="col-6">
            <label className="sub" style={{ display: 'block', marginBottom: 6 }}>Provider</label>
            <select style={inputStyle} value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providerNames.map((p) => (
                <option key={p} value={p}>{PROVIDER_LABEL[p] ?? p}{data.providers[p].hasKey ? ' ✓' : ''}</option>
              ))}
            </select>
          </div>
          <div className="col-6">
            <label className="sub" style={{ display: 'block', marginBottom: 6 }}>Model</label>
            <input style={inputStyle} value={model} list="model-options"
                   onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
            <datalist id="model-options">
              {modelsForProvider.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
        </div>

        <button className="btn btn-primary" onClick={saveModel} disabled={busy} style={{ marginTop: 14 }}>
          <Icon name="check" size={14} /> Save model
        </button>
      </section>

      {/* API keys */}
      <section className="glass reveal reveal-2" style={{ padding: 'var(--pad)' }}>
        <div className="h2" style={{ marginBottom: 4 }}>Provider API keys</div>
        <div className="sub" style={{ marginBottom: 14 }}>
          Stored server-side at /etc/helix/settings.json (0600). Keys are never sent back to the browser —
          only whether one is set. Env vars still work as a fallback.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {providerNames.map((p) => {
            const info = data.providers[p]
            const active = p === provider
            return (
              <div key={p} style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 12px', borderRadius: 12,
                border: `1px solid ${active ? 'rgba(129,140,248,.35)' : 'var(--line)'}`,
                background: active ? 'rgba(129,140,248,.06)' : 'transparent',
              }}>
                <div style={{ minWidth: 110 }}>
                  <div style={{ fontWeight: 600, fontSize: '.85rem' }}>{PROVIDER_LABEL[p] ?? p}</div>
                  <span className="pill" style={{
                    color: info.hasKey ? 'var(--ok)' : 'var(--fg-3)',
                    borderColor: (info.hasKey ? 'var(--ok)' : 'var(--fg-3)') + '55',
                    marginTop: 4,
                  }}>
                    {info.hasKey ? `set · ${info.source}` : 'not set'}
                  </span>
                </div>
                <div className="sub mono" style={{ minWidth: 70, fontSize: '.72rem' }}>
                  {info.hasKey ? info.hint : '—'}
                </div>
                <input
                  style={{ ...inputStyle, flex: 1, minWidth: 180 }}
                  type="password"
                  placeholder={info.hasKey ? 'replace key…' : 'paste key…'}
                  value={drafts[p] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p]: e.target.value }))}
                />
                <button className="btn" disabled={busy || !(drafts[p] ?? '').trim()} onClick={() => saveKey(p)}>
                  Save
                </button>
                {info.hasKey && info.source === 'settings' && (
                  <button className="btn btn-ghost" disabled={busy} onClick={() => clearKey(p)}
                          style={{ color: 'var(--bad)' }}>
                    Clear
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
