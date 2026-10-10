import { useEffect, useState } from 'react'

export const MOBILE_BP = 860

/**
 * Reactive viewport-width check. Single source of truth for responsive layout
 * across the shell and pages (matchMedia, not a resize listener).
 */
export function useIsMobile(bp: number = MOBILE_BP): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= bp : false,
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`)
    const on = () => setIsMobile(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [bp])
  return isMobile
}
