import { createContext, useContext } from 'react'

/**
 * Everything a card tab needs, loaded once by CardLayout so tabs don't each
 * re-fetch the card / health / changelog.
 */
export interface CardContextValue {
  id: string
  card: any | null              // raw card (identity, offerings, visual, provenance …)
  health: any | null
  changelog: any | null
  loading: boolean
  error: string
  reload: () => void
  /** The public URL of the generated landing page, if one exists. */
  publicUrl: string
}

export const CardContext = createContext<CardContextValue | null>(null)

export function useCard(): CardContextValue {
  const ctx = useContext(CardContext)
  if (!ctx) throw new Error('useCard must be used inside /card/:id')
  return ctx
}
