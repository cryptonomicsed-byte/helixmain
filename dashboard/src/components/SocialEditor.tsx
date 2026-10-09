import type { Socials } from '../api'

interface Props {
  socials: Socials
  onChange: (s: Socials) => void
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)', border: '1px solid var(--line-2)', borderRadius: 6,
  color: 'var(--fg)', padding: '0.4rem 0.6rem', fontSize: '0.82rem', width: '100%',
  outline: 'none',
}

const platforms: { key: keyof Socials; label: string; placeholder: string; icon: string }[] = [
  { key: 'instagram', label: 'Instagram', placeholder: '@yourbusiness', icon: '📸' },
  { key: 'facebook',  label: 'Facebook',  placeholder: 'yourbusiness',  icon: '🌐' },
  { key: 'x',         label: 'X / Twitter', placeholder: '@yourbiz',    icon: '𝕏' },
  { key: 'tiktok',    label: 'TikTok',    placeholder: '@yourbusiness', icon: '🎵' },
  { key: 'linkedin',  label: 'LinkedIn',  placeholder: 'company/your-business', icon: '💼' },
]

export function SocialEditor({ socials, onChange }: Props) {
  function set(key: keyof Socials, val: string) {
    onChange({ ...socials, [key]: val || undefined })
  }

  return (
    <div style={{ display: 'grid', gap: '0.6rem' }}>
      {platforms.map(({ key, label, placeholder, icon }) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{ width: 28, textAlign: 'center', fontSize: '1rem' }}>{icon}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--fg-2)', marginBottom: '0.15rem' }}>{label}</div>
            <input
              style={inputStyle}
              value={socials[key] ?? ''}
              onChange={(e) => set(key, e.target.value)}
              placeholder={placeholder}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
