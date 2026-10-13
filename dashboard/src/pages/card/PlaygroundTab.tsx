import { Outlet } from 'react-router-dom'
import { useCard } from './CardContext'
import { SubNav } from '../../components/SubNav'

/**
 * Playground — everything the card drives, played with in one place.
 *   Agent Voice     — pick the voice and compile the greeting (GreetingPage)
 *   Jingles & Audio — voice preview + the brand jingle (VoiceStudioPage)
 *   Test Agent      — chat with the card-grounded agent; run the test suite (PlaygroundPage)
 *
 * The old Voice, Studio and Playground tabs were three faces of the same job
 * (make and try the agent's output), so they are one section with three sub-tabs.
 */
export function PlaygroundTab() {
  const { id } = useCard()
  return (
    <div>
      <div className="reveal" style={{ marginBottom: '1rem' }}>
        <div className="h1">Playground</div>
        <div className="sub" style={{ marginTop: 4 }}>
          Everything this card drives, in one place — tune the agent's voice and greeting, compose
          your brand audio, then test the agent before it goes live.
        </div>
      </div>

      <SubNav tabs={[
        { to: `/card/${id}/playground`,       label: 'Agent Voice',     icon: 'mic',   end: true },
        { to: `/card/${id}/playground/audio`, label: 'Jingles & Audio', icon: 'spark' },
        { to: `/card/${id}/playground/lab`,   label: 'Test Agent',      icon: 'flask' },
      ]} />

      <Outlet />
    </div>
  )
}
