/* Inline SVG icon set — replaces the emoji in the old shell.
   Stroke-based (Lucide-style), inherits currentColor. No dependency. */
import type { CSSProperties } from 'react'

const P: Record<string, string> = {
  dashboard: 'M3 3h7v7H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 14h7v7H3z',
  onboard:   'M12 5v14M5 12h14',
  approvals: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  flask:     'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3',
  pin:       'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  pipeline:  'M4 5h5v14H4zM10.5 8h5v8h-5zM17 11h3v2h-3z',
  intel:     'M12 3l7 4v6c0 5-3.5 7.5-7 8-3.5-.5-7-3-7-8V7zM9.5 12l1.8 1.8L15 9.8',
  campaign:  'M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14',
  calendar:  'M3 5h18v16H3zM3 10h18M8 3v4M16 3v4',
  mic:       'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v4M8 22h8',
  folder:    'M3 6h6l2 2h10v12H3z',
  card:      'M2 5h20v14H2zM2 10h20M6 15h4',
  company:   'M3 21h18M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M9 7h2M9 11h2M9 15h2M15 21V9h4a2 2 0 0 1 2 2v10',
  search:    'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  bell:      'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  logout:    'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  check:     'M4 12.5l5 5L20 6.5',
  x:         'M6 6l12 12M18 6L6 18',
  arrow:     'M5 12h14M13 6l6 6-6 6',
  spark:     'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  bolt:      'M13 2L4 14h6l-1 8 9-12h-6z',
  menu:      'M3 6h18M3 12h18M3 18h18',
  panel:     'M3 4h18v16H3zM9 4v16',
  globe:     'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2c3 3.5 3 16.5 0 20M12 2c-3 3.5-3 16.5 0 20',
  clock:     'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3.5 2',
  shield:    'M12 3l7 4v6c0 5-3.5 7.5-7 8-3.5-.5-7-3-7-8V7z',
  qr:        'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  layers:    'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  users:     'M16 21v-2a4 4 0 0 0-8 0v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM22 21v-2a4 4 0 0 0-3-3.9',
  coin:      'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4',
  settings:  'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.09 3V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
}

export function Icon({ name, size = 16, style }: { name: string; size?: number; style?: CSSProperties }) {
  const d = P[name] ?? P.spark
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
         style={{ flexShrink: 0, ...style }} aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
