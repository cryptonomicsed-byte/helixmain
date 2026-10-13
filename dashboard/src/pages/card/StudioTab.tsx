import { Outlet, useParams } from 'react-router-dom'
import { SubNav, type SubTab } from '../../components/SubNav'

// The Studio is the card's audio suite: one place to tune the agent's voice and
// greeting, and to generate brand audio (jingles). Merged from the former
// separate "Voice" (greeting) and "Studio" tabs so all card audio lives together.
export function StudioTab() {
  const { id = '' } = useParams<{ id: string }>()

  const tabs: SubTab[] = [
    { to: `/card/${id}/studio`,       label: 'Agent Voice',     icon: 'mic',   end: true },
    { to: `/card/${id}/studio/audio`, label: 'Jingles & Audio', icon: 'spark' },
  ]

  return (
    <div>
      <div className="reveal" style={{ marginBottom: '1rem' }}>
        <div className="h1">Studio</div>
        <div className="sub" style={{ marginTop: 4 }}>
          Everything audio for this card — the agent's voice and greeting, and generated brand audio.
        </div>
      </div>

      <SubNav tabs={tabs} />

      <Outlet />
    </div>
  )
}
