import { create } from 'zustand'
import type { Company, BuildStatus, BusinessCard } from './api'

interface HelixStore {
  companies: Company[]
  currentCompany: Company | null
  currentCard: BusinessCard | null
  buildStatus: BuildStatus | null
  setCompanies: (c: Company[]) => void
  setCurrentCompany: (c: Company | null) => void
  setCurrentCard: (c: BusinessCard | null) => void
  setBuildStatus: (s: BuildStatus) => void
}

export const useHelixStore = create<HelixStore>((set) => ({
  companies: [],
  currentCompany: null,
  currentCard: null,
  buildStatus: null,

  setCompanies: (companies) => set({ companies }),
  setCurrentCompany: (currentCompany) => set({ currentCompany }),
  setCurrentCard: (currentCard) => set({ currentCard }),
  setBuildStatus: (buildStatus) => set({ buildStatus }),
}))
