import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useCard } from './CardContext'
import { api } from '../../api'
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

export function SiteTab() {
  const { id, card, publicUrl } = useCard()
  const [hasSite, setHasSite] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [copied, setCopied] = useState(false)

  const phone: string = card?.identity?.phone ?? ''

  async function refreshSiteState() {
    try {
      const s = await api.listSites()
      setHasSite((s.companies ?? []).includes(id))
    } catch { setHasSite(false) }
  }

  useEffect(() => { refreshSiteState() /* eslint-disable-next-line */ }, [id])

  async function regenerate() {
    setBusy(true); setNotice('')
    try {
      const r = await api.generateSite(id)
      setNotice(r?.ok ? 'Site regenerated from the current card.' : 'Generation returned no result.')
      await refreshSiteState()
    } catch (e) {
      setNotice(`Generation failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setBusy(false) }
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
            Landing page
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={regenerate} disabled={busy} style={{ fontSize: '.78rem' }}>
            <Icon name="globe" size={14} /> {busy ? 'Generating…' : 'Regenerate site'}
          </button>
          {hasSite && (
            <button className="btn btn-ghost" onClick={() => window.open(publicUrl, '_blank', 'noopener')} style={{ fontSize: '.78rem' }}>
              Open ↗
            </button>
          )}
        </div>
        {notice && <div className="pill pill-ok" style={{ marginBottom: '.6rem', display: 'inline-block' }}>{notice}</div>}
        {hasSite === false ? (
          <div className="sub" style={{ fontSize: '.85rem' }}>
            No site generated yet for this card. Press <strong>Regenerate site</strong> to build the single-file landing page from the card.
          </div>
        ) : hasSite ? (
          <iframe title="landing-preview" src={publicUrl}
            style={{ width: '100%', height: 460, border: '1px solid var(--line-2)', borderRadius: 10, background: '#fff' }} />
        ) : (
          <div className="sub" style={{ fontSize: '.85rem' }}>Checking…</div>
        )}
      </div>

      {/* QR codes */}
      <div style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--fg-3)', fontWeight: 600, marginBottom: '.6rem' }}>
        QR codes
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '.75rem', marginBottom: '1rem' }}>
        <QrCard label="Landing page" text={publicUrl} note={hasSite ? undefined : 'generate a site first'} />
        {phone
          ? <QrCard label="Call the business" text={`tel:${phone.replace(/\s/g, '')}`} />
          : <QrCard label="Call the business" text="not set" note="no phone on the card" />}
        <QrCard label="Talk to AI Agent" text={`https://helixmain.duckdns.org/api/call/${id}`} note="scan to chat with Helix AI" />
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
