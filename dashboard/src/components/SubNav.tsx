import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Icon } from './Icon'

/** A tab strip for a section with sub-views (Studio, Settings, Leads).
 *  Same visual language as the card tab nav, so a section reads as a section. */
export interface SubTab {
  to: string
  label: string
  icon: string
  /** exact-match only — set on the index tab so it isn't active on sub-paths. */
  end?: boolean
  /** optional count badge (e.g. pending approvals). */
  badge?: number
}

export function SubNav({ tabs, right }: { tabs: SubTab[]; right?: ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: '.25rem', overflowX: 'auto', paddingBottom: '.5rem',
      marginBottom: '1rem', borderBottom: '1px solid var(--line)', alignItems: 'center',
    }}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end}
          style={({ isActive }) => ({
            display: 'inline-flex', alignItems: 'center', gap: '.4rem', whiteSpace: 'nowrap',
            padding: '.4rem .7rem', borderRadius: 9, fontSize: '.83rem', textDecoration: 'none',
            color: isActive ? 'var(--fg)' : 'var(--fg-3)',
            fontWeight: isActive ? 600 : 450,
            background: isActive ? 'linear-gradient(90deg, rgba(129,140,248,.16), rgba(129,140,248,.03))' : 'transparent',
            transition: 'background 160ms, color 160ms',
          })}>
          <Icon name={t.icon} size={14} /> {t.label}
          {typeof t.badge === 'number' && t.badge > 0 && (
            <span className="pill" style={{ fontSize: '.62rem', padding: '.02rem .38rem', lineHeight: 1.5 }}>
              {t.badge}
            </span>
          )}
        </NavLink>
      ))}
      {right && <><div style={{ flex: 1 }} />{right}</>}
    </div>
  )
}
