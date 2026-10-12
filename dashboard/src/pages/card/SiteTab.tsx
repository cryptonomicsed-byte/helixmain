import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useCard } from './CardContext'
import { api, type Landing } from '../../api'
import { Icon } from '../../components/Icon'

function useQr(text: string): string {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let live = true
    if (!text) { setUrl(''); return }
    QRCode.toDataURL(text, { margin: 1, width: 220, color: { dark: '#0b0d16', light: '#e6e8ea' } })
      .then((u) => { if (live) setUrl(u) })
      .catch(() => { if (live) setUrl('') })
    return () => { live = false }
  }, [text])
  return url
}

function QrCard({ label, text, note }: { label: string; text: string; note?: string }) {
  const url = useQr(text)
  return (
    <div className="panel" style={{ padding: '.85rem', display: 'flex', flexDirection: 'column', gap: '.5rem', alignItems: 'center' }}>
      <div style={{ fontSize: '.8rem', fontWeight: 650 }}>{label}</div>
      {url
        ? <img src={url} alt={`${label} QR`} width={168} height={168} style={{ borderRadius: 8, background: '#fff', padding: 4 }} />
        : <div style={{ width: 168, height: 168, display: 'grid', placeItems: 'center', color: 'var(--fg-3)', fontSize: '.78rem' }}>no QR</div>}
      <div className="sub mono" style={{ fontSize: '.68rem', wordBreak: 'break-all', textAlign: 'center', maxWidth: 190 }}>{text}</div>
      {url && (
        <a href={url} download={`${label.replace(/\s+/g, '-').toLowerCase()}-qr.png`}
          className="btn btn-ghost" style={{ fontSize: '.75rem', padding: '.3rem .7rem', textDecoration: 'none' }}>
          <Icon name="layers" size={13} /> Download
        </a>
      )}
      {note && <div className="sub" style={{ fontSize: '.68rem', textAlign: 'center' }}>{note}</div>}
    </div>
  )
}

function LandingQr({ text }: { text: string }) {
  const url = useQr(text)
  return url
    ? <img src={url} alt="landing QR" width={128} height={128} style={{ borderRadius: 6, background: '#fff', padding: 3 }} />
    : null
}

export function SiteTab() {
  const { id, card, publicUrl } = useCard()
  const [published, setPublished] = useState<boolean | null>(null)
  const [draftUrl, setDraftUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState(false)

  const phone: string = card?.identity?.phone ?? ''

  // Landing pages are SEPARATE artifacts from the directory page above: creating
  // one adds a page, it never replaces the directory entry.
  const [landings, setLandings] = useState<Landing[]>([])
  const [landingTitle, setLandingTitle] = useState('')

  async function refreshLandings() {
    try { const r = await api.listLandings(id); setLandings(r.landings || []) } catch { setLandings([]) }
  }
  useEffect(() => { refreshLandings() /* eslint-disable-next-line */ }, [id])

  async function addLanding() {
    setBusy('landing'); setNotice('')
    try {
      const r = await api.createLanding(id, landingTitle.trim() || undefined)
      setNotice(`Landing page created: ${r.landing?.title ?? ''}`)
      setLandingTitle('')
      await refreshLandings()
    } catch (e) { setNotice(`Landing failed: ${e instanceof Error ? e.message : String(e)}`) }
    finally { setBusy('') }
  }

  async function removeLanding(slug: string) {
    try { await api.deleteLanding(id, slug); await refreshLandings() } catch { /* ignore */ }
  }

  // `published` comes from the web root (what a visitor can actually load), not
  // from the in-memory preview cache — those are different things, and conflating
  // them is what made a live page look broken.
  async function refreshSiteState() {
    try {
      const s = await api.listSites()
      setPublished((s.published ?? []).includes(id))
    } catch { setPublished(false) }
  }

  useEffect(() => { refreshSiteState(); setDraftUrl('') /* eslint-disable-next-line */ }, [id])

  async function publish() {
    setBusy('publish'); setNotice('')
    try {
      const r = await api.publishSite(id)
      setNotice(r?.url
        ? `Published to ${r.url}${r.creditsCharged ? ` (${r.creditsCharged} credits)` : ''}`
        : 'Publish returned no result.')
      setDraftUrl('')
      await refreshSiteState()
    } catch (e) {
      setNotice(`Publish failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy('') }
  }

  async function previewDraft() {
    setBusy('preview'); setNotice('')
    try {
      const r = await api.previewSite(id)
      setDraftUrl(`${window.location.origin}${r.previewUrl}`)
      setNotice('Draft generated — this is a private draft, not the published page.')
    } catch (e) {
      setNotice(`Draft failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy('') }
  }

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    } catch { setNotice('Clipboard unavailable — copy the URL manually.') }
  }

  return (
    <div>
      {/* Landing page */}
      <div className="panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.7rem', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600 }}>
            Directory page
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={publish} disabled={!!busy} style={{ fontSize: '.78rem' }}>
            <Icon name="globe" size={14} /> {busy === 'publish' ? 'Publishing…' : published ? 'Republish site' : 'Publish site'}
          </button>
          <button className="btn btn-ghost" onClick={previewDraft} disabled={!!busy} style={{ fontSize: '.78rem' }}>
            <Icon name="spark" size={14} /> {busy === 'preview' ? 'Drafting…' : 'Preview draft'}
          </button>
          {published && (
            <button className="btn btn-ghost" onClick={() => window.open(publicUrl, '_blank', 'noopener')} style={{ fontSize: '.78rem' }}>
              Open ↗
            </button>
          )}
        </div>
        {notice && <div className="pill pill-ok" style={{ marginBottom: '.6rem', display: 'inline-block' }}>{notice}</div>}
        {draftUrl ? (
          <>
            <div className="sub" style={{ fontSize: '.72rem', marginBottom: '.4rem' }}>
              Private draft — <a href={draftUrl} target="_blank" rel="noreferrer">open in a tab</a>
            </div>
            <iframe title="draft-preview" src={draftUrl}
              style={{ width: '100%', height: 460, border: '1px solid var(--line-2)', borderRadius: 10, background: '#fff' }} />
          </>
        ) : published === false ? (
          <div className="sub" style={{ fontSize: '.85rem' }}>
            This card has no published page yet. Press <strong>Publish site</strong> to build it from the
            card — that is the page at <span className="mono">{publicUrl}</span> that the QR code and NFC tag point at.
            <strong> Preview draft</strong> shows a private draft first without publishing.
          </div>
        ) : published ? (
          <iframe title="landing-preview" src={publicUrl}
            style={{ width: '100%', height: 460, border: '1px solid var(--line-2)', borderRadius: 10, background: '#fff' }} />
        ) : (
          <div className="sub" style={{ fontSize: '.85rem' }}>Checking…</div>
        )}
      </div>

      {/* Landing pages — additive. Creating one adds a new page beside the
          directory page; it never replaces the directory entry. */}
      <div className="panel" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginBottom: '.7rem', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600 }}>
            Landing pages
          </div>
          <div style={{ flex: 1 }} />
          <input value={landingTitle} onChange={(e) => setLandingTitle(e.target.value)} placeholder="Title (optional)"
            style={{ background: 'rgba(0,0,0,.25)', border: '1px solid var(--line-2)', borderRadius: 8, color: 'var(--fg-2)', padding: '.4rem .6rem', fontSize: '.8rem', outline: 'none', width: 180 }} />
          <button className="btn btn-primary" onClick={addLanding} disabled={!!busy} style={{ fontSize: '.78rem' }}>
            <Icon name="spark" size={14} /> {busy === 'landing' ? 'Creating…' : 'New landing page'}
          </button>
        </div>
        {landings.length === 0
          ? <div className="sub" style={{ fontSize: '.85rem' }}>
              No landing pages yet. Creating one adds a page at <span className="mono">/l/{id}/…</span> beside the
              directory page — it never replaces the directory entry.
            </div>
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '.75rem' }}>
              {landings.map((l) => (
                <div className="panel" key={l.slug} style={{ padding: '.75rem', display: 'flex', flexDirection: 'column', gap: '.4rem', alignItems: 'center' }}>
                  <div style={{ fontWeight: 650, fontSize: '.85rem', textAlign: 'center' }}>{l.title}</div>
                  <LandingQr text={`${typeof window !== 'undefined' ? window.location.origin : ''}${l.url}`} />
                  <div className="sub mono" style={{ fontSize: '.66rem', wordBreak: 'break-all', textAlign: 'center' }}>{l.url}</div>
                  <div style={{ display: 'flex', gap: '.4rem' }}>
                    <button className="btn btn-ghost" onClick={() => window.open(l.url, '_blank', 'noopener')} style={{ fontSize: '.74rem' }}>Open ↗</button>
                    <button className="btn btn-ghost" onClick={() => removeLanding(l.slug)} style={{ fontSize: '.74rem' }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>

      {/* QR codes */}
      <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600, marginBottom: '.6rem' }}>
        QR codes
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '.75rem', marginBottom: '1rem' }}>
        <QrCard label="Landing page" text={publicUrl} note={published ? undefined : 'publish a site first'} />
        {phone
          ? <QrCard label="Call the business" text={`tel:${phone.replace(/\s/g, '')}`} />
          : <QrCard label="Call the business" text="not set" note="no phone on the card" />}
        <QrCard label="Talk to AI Agent" text={`https://helixmain.duckdns.org/call/${id}`} note="scan to talk to Helix AI (orb)" />
      </div>

      {/* NFC payload */}
      <div className="panel" style={{ padding: '1rem 1.25rem' }}>
        <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600, marginBottom: '.6rem' }}>
          NFC payload
        </div>
        <div className="sub" style={{ fontSize: '.82rem', marginBottom: '.5rem' }}>
          Write this URL to an NFC tag — tapping it opens this business's page.
        </div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <input readOnly value={publicUrl}
            style={{ flex: '1 1 260px', background: 'rgba(0,0,0,.25)', border: '1px solid var(--line-2)', borderRadius: 8,
                     color: 'var(--fg-2)', padding: '.5rem .7rem', fontSize: '.82rem', outline: 'none' }} />
          <button className="btn btn-primary" onClick={copyPayload} style={{ fontSize: '.8rem' }}>
            <Icon name={copied ? 'check' : 'layers'} size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}
