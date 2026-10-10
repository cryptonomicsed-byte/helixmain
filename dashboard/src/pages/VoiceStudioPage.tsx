import { authFetch } from '../api'
import { useState, useEffect, useCallback } from 'react'
import { useHelixStore } from '../store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VoiceOption {
  id: string
  provider: 'kokoro' | 'elevenlabs' | 'openai-tts' | 'browser'
  voiceName: string
  language: string
  gender: 'male' | 'female' | 'neutral'
  style: string
  available: boolean
}

interface SampleResult {
  audioUrl: string   // data:audio/mp3;base64,...
  durationMs: number
}

interface JingleBrief {
  lyrics: string
  bpm: number
  mood: string
  instruments: string[]
  duration: string
}

interface JingleResult {
  companyId: string
  brief: JingleBrief
  voiceScript: string
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const page: React.CSSProperties = {
  maxWidth: 900,
  margin: '0 auto',
}

const sectionCard: React.CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--surface)',
  borderRadius: 10,
  padding: '1.5rem',
  marginBottom: '1.75rem',
}

const sectionTitle: React.CSSProperties = {
  fontSize: '1.05rem',
  fontWeight: 700,
  color: 'var(--brand)',
  marginBottom: '1.1rem',
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
}

const voiceGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  gap: '0.75rem',
}

const voiceCard: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--surface)',
  borderRadius: 8,
  padding: '0.85rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.4rem',
}

const badge = (color: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '0.15rem 0.5rem',
  borderRadius: 4,
  fontSize: '0.68rem',
  fontWeight: 600,
  background: color + '22',
  color: color,
  border: `1px solid ${color}44`,
})

const btn = (variant: 'primary' | 'secondary' | 'ghost', disabled?: boolean): React.CSSProperties => ({
  padding: '0.45rem 1rem',
  borderRadius: 6,
  fontSize: '0.82rem',
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  border: variant === 'primary' ? 'none' : '1px solid var(--line-2)',
  background:
    variant === 'primary' ? 'var(--brand-2)'
    : variant === 'secondary' ? 'var(--surface)'
    : 'transparent',
  color: variant === 'primary' ? '#fff' : 'var(--fg-2)',
  transition: 'opacity 0.12s',
})

const lyricsBlock: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--surface)',
  borderRadius: 6,
  padding: '0.9rem 1rem',
  fontFamily: 'monospace',
  fontSize: '0.85rem',
  color: 'var(--fg)',
  whiteSpace: 'pre-wrap',
  lineHeight: 1.7,
  marginBottom: '0.75rem',
}

const metaRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  alignItems: 'center',
  marginBottom: '0.6rem',
}

const hookBox: React.CSSProperties = {
  background: '#6366f111',
  border: '1px solid #6366f133',
  borderRadius: 6,
  padding: '0.7rem 1rem',
  color: 'var(--brand)',
  fontSize: '0.9rem',
  fontStyle: 'italic',
  marginTop: '0.5rem',
}

const emptyHint: React.CSSProperties = {
  color: 'var(--fg-3)',
  fontSize: '0.85rem',
  padding: '2rem 0',
  textAlign: 'center',
}

// ---------------------------------------------------------------------------
// Provider badge
// ---------------------------------------------------------------------------

function ProviderBadge({ provider }: { provider: VoiceOption['provider'] }) {
  const color = provider === 'elevenlabs' ? 'var(--warn)' : 'var(--ok)'
  const label = provider === 'elevenlabs' ? 'ElevenLabs' : 'Kokoro'
  return <span style={badge(color)}>{label}</span>
}

// ---------------------------------------------------------------------------
// VoiceStudioPage
// ---------------------------------------------------------------------------

export function VoiceStudioPage() {
  const { currentCompany } = useHelixStore()

  // ---- Voice section state ----
  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [voicesLoading, setVoicesLoading] = useState(true)
  const [previewingId, setPreviewingId] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // ---- Jingle section state ----
  const [jingle, setJingle] = useState<JingleResult | null>(null)
  const [jingleLoading, setJingleLoading] = useState(false)
  const [jingleError, setJingleError] = useState<string | null>(null)

  // ---- Load voices on mount ----
  useEffect(() => {
    setVoicesLoading(true)
    authFetch('/voices')
      .then((r) => r.json())
      .then((data: VoiceOption[]) => setVoices(data))
      .catch(() => setVoices([]))
      .finally(() => setVoicesLoading(false))
  }, [])

  // ---- Load existing jingle for current company ----
  useEffect(() => {
    if (!currentCompany) return
    setJingle(null)
    authFetch(`/voice/jingle/${currentCompany.id}`)
      .then((r) => {
        if (!r.ok) return null
        return r.json() as Promise<JingleResult>
      })
      .then((j) => { if (j) setJingle(j) })
      .catch(() => {/* no jingle yet */})
  }, [currentCompany])

  // ---- Preview a voice ----
  const handlePreview = useCallback(async (voice: VoiceOption) => {
    setPreviewingId(voice.id)
    setPreviewError(null)

    const companyName = currentCompany?.name ?? 'us'
    const text = `Hello, welcome to ${companyName}. How can I help you today?`

    try {
      const res = await authFetch('/voices/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceProfile: voice.id, text }),
      })
      const data = (await res.json()) as SampleResult

      if (!data.audioUrl) {
        setPreviewError(`${voice.voiceName}: provider unavailable`)
        return
      }

      // audioUrl is already a data: URI (base64 encoded mp3)
      const audio = new Audio(data.audioUrl)
      audio.play().catch(() => {
        setPreviewError('Browser blocked audio autoplay — click again to retry.')
      })
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setPreviewingId(null)
    }
  }, [currentCompany])

  // ---- Generate jingle ----
  const handleGenerateJingle = useCallback(async () => {
    if (!currentCompany) return
    setJingleLoading(true)
    setJingleError(null)

    try {
      const res = await authFetch('/voice/jingle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: currentCompany.id }),
      })
      const data = (await res.json()) as { ok: boolean; jingle?: JingleResult; error?: string }
      if (!data.ok || !data.jingle) {
        setJingleError(data.error ?? 'Jingle generation failed')
        return
      }
      setJingle(data.jingle)
    } catch (e) {
      setJingleError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setJingleLoading(false)
    }
  }, [currentCompany])

  // ---- No company selected ----
  if (!currentCompany) {
    return (
      <div style={page}>
        <div style={sectionCard}>
          <p style={emptyHint}>Select a company from the top bar to use Voice Studio.</p>
        </div>
      </div>
    )
  }

  // ---- Render ----
  return (
    <div style={page}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--fg)', marginBottom: '1.5rem' }}>
        Voice Studio
      </h1>

      {/* ------------------------------------------------------------------ */}
      {/* Section 1: Voice Preview                                            */}
      {/* ------------------------------------------------------------------ */}
      <div style={sectionCard}>
        <div style={sectionTitle}>
          <span>🎙</span> Voice Preview
        </div>

        {previewError && (
          <div style={{
            background: '#ef444411', border: '1px solid #ef444433', borderRadius: 6,
            padding: '0.6rem 0.9rem', color: 'var(--bad)', fontSize: '0.82rem', marginBottom: '0.9rem',
          }}>
            {previewError}
          </div>
        )}

        {voicesLoading ? (
          <p style={{ color: 'var(--fg-3)', fontSize: '0.85rem' }}>Loading voices…</p>
        ) : voices.length === 0 ? (
          <p style={emptyHint}>No voices available.</p>
        ) : (
          <div style={voiceGrid}>
            {voices.map((v) => (
              <div key={v.id} style={voiceCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--fg)', fontSize: '0.88rem', fontWeight: 600 }}>
                    {v.voiceName}
                  </span>
                  <ProviderBadge provider={v.provider} />
                </div>

                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                  <span style={badge('var(--fg-2)')}>{v.gender}</span>
                  <span style={badge('var(--brand)')}>{v.style}</span>
                  <span style={{ fontSize: '0.68rem', color: 'var(--fg-3)' }}>{v.language}</span>
                </div>

                <button
                  style={btn('secondary', previewingId === v.id)}
                  disabled={previewingId === v.id}
                  onClick={() => handlePreview(v)}
                >
                  {previewingId === v.id ? 'Playing…' : '▶ Preview'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2: Brand Jingle Generator                                   */}
      {/* ------------------------------------------------------------------ */}
      <div style={sectionCard}>
        <div style={sectionTitle}>
          <span>🎵</span> Brand Jingle
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <button
            style={btn('primary', jingleLoading)}
            disabled={jingleLoading}
            onClick={handleGenerateJingle}
          >
            {jingleLoading ? 'Composing your brand jingle…' : jingle ? '↺ Regenerate Jingle' : '✦ Generate Jingle'}
          </button>
        </div>

        {jingleError && (
          <div style={{
            background: '#ef444411', border: '1px solid #ef444433', borderRadius: 6,
            padding: '0.6rem 0.9rem', color: 'var(--bad)', fontSize: '0.82rem', marginBottom: '0.9rem',
          }}>
            {jingleError}
          </div>
        )}

        {jingle && (
          <div>
            {/* Lyrics */}
            <div style={{ color: 'var(--fg-2)', fontSize: '0.75rem', marginBottom: '0.35rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Lyrics
            </div>
            <pre style={lyricsBlock}>{jingle.brief.lyrics}</pre>

            {/* Metadata row */}
            <div style={metaRow}>
              <span style={badge('var(--ok)')}>{jingle.brief.bpm} BPM</span>
              <span style={badge('var(--brand)')}>{jingle.brief.mood}</span>
              <span style={badge('var(--warn)')}>{jingle.brief.duration}</span>
              {jingle.brief.instruments.map((inst) => (
                <span key={inst} style={badge('var(--fg-2)')}>{inst}</span>
              ))}
            </div>

            {/* Voice hook */}
            <div style={{ color: 'var(--fg-2)', fontSize: '0.75rem', marginBottom: '0.35rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Voice Hook
            </div>
            <div style={hookBox}>"{jingle.voiceScript}"</div>

            {/* Footer */}
            <div style={{ color: 'var(--line-2)', fontSize: '0.72rem', marginTop: '0.75rem' }}>
              Generated {new Date(jingle.generatedAt).toLocaleString()}
            </div>
          </div>
        )}

        {!jingle && !jingleLoading && (
          <p style={emptyHint}>
            No jingle yet — click Generate Jingle to create one from your brand card.
          </p>
        )}
      </div>
    </div>
  )
}
