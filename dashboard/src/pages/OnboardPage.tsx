import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../api'
import { useHelixStore } from '../store'
import type { BusinessCard } from '../api'

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)', border: '1px solid var(--line-2)', borderRadius: 8,
  color: 'var(--fg)', padding: '0.55rem 0.85rem', fontSize: '0.9rem', width: '100%',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.78rem', color: 'var(--fg-2)', marginBottom: '0.3rem', display: 'block', fontWeight: 500,
}

type Phase = 'input' | 'extracting' | 'review' | 'compiling' | 'done'

function FieldRow({ label, field, onChange }: {
  label: string
  field: { value: string | null; inferred: boolean; confidence: number } | undefined
  onChange: (v: string) => void
}) {
  if (field === undefined) return null
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <label style={labelStyle}>
        {label}
        {field.inferred && (
          <span style={{
            marginLeft: '0.5rem', fontSize: '0.68rem',
            color: 'var(--warn)', background: '#f59e0b18',
            borderRadius: 4, padding: '0.1rem 0.35rem',
          }}>
            inferred {Math.round(field.confidence * 100)}%
          </span>
        )}
        {!field.inferred && (
          <span style={{
            marginLeft: '0.5rem', fontSize: '0.68rem',
            color: 'var(--ok)', background: '#22c55e18',
            borderRadius: 4, padding: '0.1rem 0.35rem',
          }}>
            confirmed
          </span>
        )}
      </label>
      <input
        style={inputStyle}
        value={field.value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

export function OnboardPage() {
  const navigate = useNavigate()
  const setCurrentCompany = useHelixStore((s) => s.setCurrentCompany)

  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('input')
  const [error, setError] = useState<string | null>(null)
  const [card, setCard] = useState<BusinessCard | null>(null)
  // Set when the API reports (409 card_exists) that this company already has a card,
  // so we ask before replacing it rather than silently destroying the old one.
  const [existing, setExisting] = useState<{ name: string; version: number } | null>(null)

  // Local edits on top of extracted card
  const [edits, setEdits] = useState<Record<string, string>>({})

  function patchField(key: string, val: string) {
    setEdits((prev) => ({ ...prev, [key]: val }))
  }

  function resolvedField(key: keyof BusinessCard) {
    const f = card?.[key] as { value: string | null; inferred: boolean; confidence: number } | undefined
    if (!f) return undefined
    return { ...f, value: key in edits ? edits[key as string] : (f.value ?? '') }
  }

  async function runExtract(replace: boolean) {
    if (!url.trim()) return
    setError(null)
    setPhase('extracting')
    try {
      // The card lands in the AUTHENTICATED company — there is no org field to
      // fill. The old "Org ID" input auto-generated `org_<timestamp>` and the API
      // correctly rejected it as a foreign tenant, so every extraction minted a
      // brand-new company directory (the org_* clutter).
      const extracted = await api.extract(url.trim(), replace)
      setCard(extracted)
      setExisting(null)
      setPhase('review')
    } catch (err) {
      // 409 = the company already has a card. Ask before replacing it; the API
      // snapshots the old card, so "Replace" is reversible.
      if (err instanceof ApiError && err.status === 409 && err.body?.error === 'card_exists') {
        setExisting({
          name: err.body?.current?.name ?? 'this company',
          version: err.body?.current?.version ?? 1,
        })
        setError(null)
        setPhase('input')
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      setPhase('input')
    }
  }

  function handleExtract(e: React.FormEvent) {
    e.preventDefault()
    void runExtract(false)
  }

  async function handleGoLive() {
    if (!card) return
    setPhase('compiling')
    setError(null)
    try {
      await api.compile(card.id, card.org_id)
      setCurrentCompany({
        id: card.org_id,
        name: (edits['name'] ?? card.name?.value) || card.org_id,
        cardVersion: card.version,
        lastUpdated: new Date().toISOString(),
      })
      setPhase('done')
      setTimeout(() => navigate(`/card/${card.org_id}`), 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('review')
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--fg)', marginBottom: '0.4rem' }}>
        Onboard a Business
      </h1>
      <p style={{ color: 'var(--fg-3)', fontSize: '0.875rem', marginBottom: '2rem' }}>
        Enter a business URL and we'll extract its card automatically.
      </p>

      {/* Step 1 — URL input */}
      {(phase === 'input' || phase === 'extracting') && (
        <form onSubmit={handleExtract}>
          <div className="glass" style={{ background: 'var(--surface)', borderRadius: 12, padding: '1.5rem', border: '1px solid var(--line-2)' }}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Business website or brand name *</label>
              <input
                style={inputStyle}
                type="text"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="yourbusiness.com — or just a brand name"
                required
                disabled={phase === 'extracting'}
              />
            </div>
            {existing && (
              <div style={{
                marginBottom: '1.25rem', padding: '0.85rem',
                background: '#f59e0b14', border: '1px solid #f59e0b55',
                borderRadius: 8, fontSize: '0.85rem', color: 'var(--fg)',
              }}>
                <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
                  {existing.name} already has a card (v{existing.version}).
                </div>
                <div style={{ color: 'var(--fg-3)', marginBottom: '0.7rem' }}>
                  Extracting again replaces it. Your current card is snapshotted first, so this is recoverable.
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => void runExtract(true)}
                    disabled={phase === 'extracting'}
                    style={{
                      background: '#f59e0b', color: '#1a1205', border: 'none', borderRadius: 6,
                      padding: '0.45rem 0.9rem', fontSize: '0.82rem', fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    Replace the card
                  </button>
                  <button
                    type="button"
                    onClick={() => setExisting(null)}
                    style={{
                      background: 'transparent', color: 'var(--fg-2)', border: '1px solid var(--line-2)',
                      borderRadius: 6, padding: '0.45rem 0.9rem', fontSize: '0.82rem', cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {error && (
              <div style={{ color: 'var(--bad)', fontSize: '0.82rem', marginBottom: '1rem', padding: '0.6rem', background: '#ef444411', borderRadius: 6 }}>
                {error}
              </div>
            )}
            <button type="submit" disabled={phase === 'extracting'} style={{
              background: phase === 'extracting' ? 'var(--line-2)' : 'var(--brand-2)',
              color: '#fff', border: 'none', borderRadius: 8,
              padding: '0.6rem 1.5rem', fontSize: '0.9rem', fontWeight: 600,
              cursor: phase === 'extracting' ? 'not-allowed' : 'pointer', width: '100%',
            }}>
              {phase === 'extracting' ? '⏳ Extracting card…' : 'Extract Card'}
            </button>
          </div>
        </form>
      )}

      {/* Step 2 — Review extracted card */}
      {(phase === 'review' || phase === 'compiling') && card && (
        <div>
          <div className="glass" style={{ background: 'var(--surface)', borderRadius: 12, padding: '1.5rem',
            border: '1px solid var(--line-2)', marginBottom: '1rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--fg)', margin: 0 }}>
                Review Extracted Card
              </h2>
              <span style={{ fontSize: '0.72rem', color: 'var(--fg-3)' }}>card id: {card.id}</span>
            </div>

            <FieldRow label="Business Name" field={resolvedField('name')} onChange={(v) => patchField('name', v)} />
            <FieldRow label="Tagline" field={resolvedField('tagline')} onChange={(v) => patchField('tagline', v)} />
            <FieldRow label="Phone" field={resolvedField('phone')} onChange={(v) => patchField('phone', v)} />
            <FieldRow label="Address" field={resolvedField('address')} onChange={(v) => patchField('address', v)} />
            <FieldRow label="Website" field={resolvedField('website')} onChange={(v) => patchField('website', v)} />
            <FieldRow label="Hours" field={resolvedField('hours')} onChange={(v) => patchField('hours', v)} />
          </div>

          {error && (
            <div style={{ color: 'var(--bad)', fontSize: '0.82rem', marginBottom: '1rem', padding: '0.6rem', background: '#ef444411', borderRadius: 6 }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              onClick={() => { setPhase('input'); setCard(null); setEdits({}) }}
              disabled={phase === 'compiling'}
              style={{
                background: 'transparent', color: 'var(--fg-2)', border: '1px solid var(--line-2)',
                borderRadius: 8, padding: '0.6rem 1.25rem', fontSize: '0.875rem',
                cursor: 'pointer', fontWeight: 500,
              }}
            >
              Start Over
            </button>
            <button
              onClick={handleGoLive}
              disabled={phase === 'compiling'}
              style={{
                flex: 1, background: phase === 'compiling' ? 'var(--line-2)' : 'var(--ok)',
                color: '#fff', border: 'none', borderRadius: 8,
                padding: '0.6rem 1.5rem', fontSize: '0.9rem', fontWeight: 700,
                cursor: phase === 'compiling' ? 'not-allowed' : 'pointer',
              }}
            >
              {phase === 'compiling' ? '⏳ Compiling agent…' : 'Confirm & Go Live'}
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Done */}
      {phase === 'done' && (
        <div className="glass" style={{ background: 'var(--surface)', borderRadius: 12, padding: '2.5rem',
          textAlign: 'center', border: '1px solid #22c55e44',
        }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>✅</div>
          <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--ok)', marginBottom: '0.4rem' }}>
            Agent compiled successfully
          </div>
          <div style={{ color: 'var(--fg-3)', fontSize: '0.875rem' }}>
            Redirecting to company page…
          </div>
        </div>
      )}
    </div>
  )
}
