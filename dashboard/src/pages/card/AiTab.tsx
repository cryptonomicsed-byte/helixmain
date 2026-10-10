import { useEffect, useState } from 'react'
import { api } from '../../api'
import { Icon } from '../../components/Icon'
import { useCard } from './CardContext'
import type { CompanyAiResponse, CompanyAiPatch } from '../../api'

const PROVIDER_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini',
  groq: 'Groq', openrouter: 'OpenRouter', mistral: 'Mistral',
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,.28)', border: '1px solid var(--line-2)', borderRadius: 10,
  color: 'var(--fg)', padding: '.45rem .6rem', fontSize: '.82rem', width: '100%', outline: 'none',
}

/**
 * Per-business AI. A business can point each *aspect* (the functions that
 * actually call an LLM) at its own provider/model, carry its own provider key,
 * and cap its monthly spend. Resolution order is shown honestly per aspect:
 * aspect override → business default → account default.
 */
export function AiTab() {
  const { id: orgId } = useCard()
  const [data, setData] = useState<CompanyAiResponse | null>(null)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [budget, setBudget] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [scopeDraft, setScopeDraft] = useState<Record<string, { provider: string; model: string }>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)

  function apply(res: CompanyAiResponse) {
    setData(res)
    setProvider(res.provider ?? '')
    setModel(res.model ?? '')
    setBudget(res.budgetCredits ? String(res.budgetCredits) : '')
  }

  useEffect(() => {
    if (!orgId) return
    api.getCompanyAi(orgId)
      .then(apply)
      .catch((e) => setMsg({ kind: 'bad', text: `Could not load AI settings: ${e instanceof Error ? e.message : e}` }))
  }, [orgId])

  async function save(patch: CompanyAiPatch, okText: string) {
    setBusy(true); setMsg(null)
    try {
      apply(await api.saveCompanyAi(orgId, patch))
      setMsg({ kind: 'ok', text: okText })
    } catch (e) {
      setMsg({ kind: 'bad', text: `Save failed: ${e instanceof Error ? e.message : e}` })
    } finally { setBusy(false) }
  }

  async function saveScope(aspect: string, clear: boolean) {
    const d = scopeDraft[aspect] ?? { provider: '', model: '' }
    const patch: CompanyAiPatch = clear
      ? { scopes: { [aspect]: { provider: null, model: null } } }
      : { scopes: { [aspect]: { provider: d.provider || null, model: d.model || null } } }
    await save(patch, clear ? `Override cleared for ${aspect}.` : `Override saved for ${aspect}.`)
    setScopeDraft((s) => ({ ...s, [aspect]: { provider: '', model: '' } }))
  }

  if (!data) {
    return <div className="sub" style={{ padding: '3rem', textAlign: 'center' }}>
      {msg ? msg.text : 'Loading AI settings…'}
    </div>
  }

  const providers = data.providers
  const modelsFor = (p: string) => data.keys[p]?.models ?? []
  const toneFor = (src: string) =>
    src.startsWith('business') ? 'var(--brand)' : src === 'account default' ? 'var(--info)' : 'var(--fg-3)'

  return (
    <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="reveal">
        <div className="h1">AI for this business</div>
        <div className="sub" style={{ marginTop: 4 }}>
          Point each part of this business at its own model, give it its own key, and cap its
          monthly spend. Resolution is <strong>aspect override → business default → account default</strong>.
          Anything left blank inherits from above.
        </div>
      </div>

      {msg && (
        <div className="glass reveal" style={{ padding: '.7rem 1rem', fontSize: '.85rem',
          borderColor: (msg.kind === 'ok' ? 'var(--ok)' : 'var(--bad)') + '55',
          color: msg.kind === 'ok' ? 'var(--ok)' : 'var(--bad)' }}>
          {msg.text}
        </div>
      )}

      {/* Monthly budget cap — enforced server-side in deductCredits */}
      <section className="glass reveal reveal-1" style={{ padding: 'var(--pad)' }}>
        <div className="h2" style={{ marginBottom: 4 }}>Monthly budget cap</div>
        <div className="sub" style={{ marginBottom: 14 }}>
          Enforced by the API, not just displayed: once this business' spend for the month
          reaches the cap, further LLM work on it is refused with a quota error. Blank or 0 = uncapped.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ width: 180 }}>
            <label className="sub" style={{ display: 'block', marginBottom: 6 }}>Credits / month</label>
            <input style={inputStyle} type="number" min={0} placeholder="uncapped"
              value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
          <button className="btn btn-primary" disabled={busy || budget.trim() === ''}
            onClick={() => save(
              { budgetCredits: Number(budget) <= 0 ? null : Number(budget) },
              Number(budget) <= 0 ? 'Budget cap removed.' : `Budget cap set to ${budget} credits/month.`,
            )}>
            <Icon name="check" size={14} /> {budget.trim() === '' ? 'Set cap' : Number(budget) <= 0 ? 'Remove cap' : 'Save cap'}
          </button>
        </div>
      </section>

      {/* Business default */}
      <section className="glass reveal reveal-2" style={{ padding: 'var(--pad)' }}>
        <div className="h2" style={{ marginBottom: 4 }}>Business default</div>
        <div className="sub" style={{ marginBottom: 14 }}>
          Used by every aspect that doesn't have its own override. Account default is currently{' '}
          <span className="mono">{PROVIDER_LABEL[data.account.provider] ?? data.account.provider} · {data.account.model}</span>.
        </div>
        <div className="bento">
          <div className="col-6">
            <label className="sub" style={{ display: 'block', marginBottom: 6 }}>Provider</label>
            <select style={inputStyle} value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">— inherit account default —</option>
              {providers.map((p) => (
                <option key={p} value={p}>{PROVIDER_LABEL[p] ?? p}{data.keys[p]?.hasKey ? ' ✓' : ''}</option>
              ))}
            </select>
          </div>
          <div className="col-6">
            <label className="sub" style={{ display: 'block', marginBottom: 6 }}>Model</label>
            <input style={inputStyle} value={model} list="biz-model-options"
              placeholder="inherit" onChange={(e) => setModel(e.target.value)} />
            <datalist id="biz-model-options">
              {modelsFor(provider || data.account.provider).map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy}
            onClick={() => save({ provider: provider || null, model: model.trim() || null }, 'Business default saved.')}>
            <Icon name="check" size={14} /> Save default
          </button>
          <button className="btn btn-ghost" disabled={busy}
            onClick={() => save({ provider: null, model: null }, 'Business default cleared — now inheriting account default.')}>
            Clear
          </button>
        </div>
      </section>

      {/* Per-aspect routing */}
      <section className="glass reveal reveal-3" style={{ padding: 'var(--pad)' }}>
        <div className="h2" style={{ marginBottom: 4 }}>Route each aspect</div>
        <div className="sub" style={{ marginBottom: 14 }}>
          The functions that actually call an LLM. Each row shows what is <em>effectively</em> running right now.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.aspects.map((a) => {
            const eff = data.effective[a.key]
            const scoped = Boolean(data.scopes[a.key]?.provider || data.scopes[a.key]?.model)
            const d = scopeDraft[a.key] ?? { provider: '', model: '' }
            return (
              <div key={a.key} style={{
                padding: '10px 12px', borderRadius: 12, border: '1px solid var(--line)',
                background: scoped ? 'rgba(129,140,248,.05)' : 'transparent',
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: '.85rem' }}>{a.label}</span>
                  <span className="sub" style={{ fontSize: '.74rem' }}>{a.hint}</span>
                  <span className="pill" style={{ marginLeft: 'auto', color: toneFor(eff?.source ?? ''), borderColor: toneFor(eff?.source ?? '') + '55' }}>
                    {PROVIDER_LABEL[eff?.provider ?? ''] ?? eff?.provider} · {eff?.model} · {eff?.source}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <select style={{ ...inputStyle, width: 150 }} value={d.provider}
                    onChange={(e) => setScopeDraft((s) => ({ ...s, [a.key]: { ...d, provider: e.target.value } }))}>
                    <option value="">inherit provider</option>
                    {providers.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p] ?? p}</option>)}
                  </select>
                  <input style={{ ...inputStyle, width: 190 }} placeholder="inherit model"
                    value={d.model} onChange={(e) => setScopeDraft((s) => ({ ...s, [a.key]: { ...d, model: e.target.value } }))} />
                  <button className="btn" disabled={busy || (!d.provider && !d.model)} onClick={() => saveScope(a.key, false)}>Override</button>
                  {scoped && (
                    <button className="btn btn-ghost" style={{ color: 'var(--bad)' }} disabled={busy} onClick={() => saveScope(a.key, true)}>Clear</button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* Per-business keys */}
      <section className="glass reveal reveal-4" style={{ padding: 'var(--pad)' }}>
        <div className="h2" style={{ marginBottom: 4 }}>Keys for this business</div>
        <div className="sub" style={{ marginBottom: 14 }}>
          Optional. A business key overrides the account key for every call it makes.
          Stored 0600 at /etc/helix/companies/{orgId}/ai.json — never sent back to the browser.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {providers.map((p) => {
            const info = data.keys[p]
            return (
              <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                padding: '10px 12px', borderRadius: 12, border: '1px solid var(--line)' }}>
                <div style={{ minWidth: 110 }}>
                  <div style={{ fontWeight: 600, fontSize: '.85rem' }}>{PROVIDER_LABEL[p] ?? p}</div>
                  <span className="pill" style={{ marginTop: 4,
                    color: info?.hasKey ? 'var(--ok)' : 'var(--fg-3)',
                    borderColor: (info?.hasKey ? 'var(--ok)' : 'var(--fg-3)') + '55' }}>
                    {info?.hasKey ? `set · ${info.source}` : 'not set'}
                  </span>
                </div>
                <div className="sub mono" style={{ minWidth: 70, fontSize: '.72rem' }}>
                  {info?.hasKey ? info.hint : '—'}
                </div>
                <input style={{ ...inputStyle, flex: 1, minWidth: 180 }} type="password"
                  placeholder={info?.hasKey ? 'replace key…' : 'paste key…'}
                  value={drafts[p] ?? ''}
                  onChange={(e) => setDrafts((s) => ({ ...s, [p]: e.target.value }))} />
                <button className="btn" disabled={busy || !(drafts[p] ?? '').trim()}
                  onClick={async () => {
                    const v = (drafts[p] ?? '').trim()
                    if (!v) return
                    await save({ keys: { [p]: v } }, `${PROVIDER_LABEL[p] ?? p} key saved for this business.`)
                    setDrafts((s) => ({ ...s, [p]: '' }))
                  }}>Save</button>
                {info?.source === 'business' && (
                  <button className="btn btn-ghost" style={{ color: 'var(--bad)' }} disabled={busy}
                    onClick={() => save({ keys: { [p]: '' } }, `${PROVIDER_LABEL[p] ?? p} key cleared.`)}>Clear</button>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
