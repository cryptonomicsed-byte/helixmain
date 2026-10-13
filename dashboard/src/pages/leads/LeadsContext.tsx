import { createContext, useContext } from 'react'
import type { Company } from '../../api'

/**
 * Who a leads view is prospecting AS.
 *
 * Deliberately NOT a Company: the seller is usually the ACCOUNT itself (the
 * owner prospecting for clients), which is not an onboarded company and must
 * never be written into the global `currentCompany` store — Dashboard, Billing
 * and Greeting all read that, so a synthetic company would leak into them.
 */
export interface LeadsSeller {
  id: string
  name: string
  /** true when this seller is the account itself, not one of its businesses. */
  isAccount: boolean
}

export interface LeadsCtxValue {
  seller: LeadsSeller | null
  companies: Company[]
  setSellerId: (id: string) => void
  accountId: string
}

const EMPTY: LeadsCtxValue = { seller: null, companies: [], setSellerId: () => {}, accountId: '' }

export const LeadsContext = createContext<LeadsCtxValue>(EMPTY)

export const useLeads = () => useContext(LeadsContext)

/** The seller in the `{ id, name }` shape the leads pages consume. */
export const useLeadsSeller = () => useContext(LeadsContext).seller
