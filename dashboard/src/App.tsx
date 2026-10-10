import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DashboardPage }     from './pages/DashboardPage'
import { OnboardPage }       from './pages/OnboardPage'
import { GreetingPage }      from './pages/GreetingPage'
import { ApprovalsPage }     from './pages/ApprovalsPage'
import { PlaygroundPage }    from './pages/PlaygroundPage'
import { LeadHunterPage }    from './pages/LeadHunterPage'
import { SalesPipelinePage } from './pages/SalesPipelinePage'
import { IntelPage }         from './pages/IntelPage'
import { CampaignPage }      from './pages/CampaignPage'
import { SchedulePage }      from './pages/SchedulePage'
import { VoiceStudioPage }   from './pages/VoiceStudioPage'
import { PortfolioPage }     from './pages/PortfolioPage'
import { BillingPage }       from './pages/BillingPage'
import { SettingsPage }      from './pages/SettingsPage'

import { CardLayout }  from './pages/card/CardLayout'
import { OverviewTab } from './pages/card/OverviewTab'
import { CardTab }     from './pages/card/CardTab'
import { SiteTab }     from './pages/card/SiteTab'
import { HistoryTab }  from './pages/card/HistoryTab'

/** /company/:id → /card/:id, preserving the id. */
function LegacyCompany() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={id ? `/card/${id}` : '/'} replace />
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        {/* Global — the only things that are account-wide */}
        <Route index                   element={<DashboardPage />} />
        <Route path="onboard"          element={<OnboardPage />} />
        <Route path="approvals"        element={<ApprovalsPage />} />
        <Route path="settings"         element={<SettingsPage />} />
        <Route path="portfolio"        element={<PortfolioPage />} />
        <Route path="billing"          element={<BillingPage />} />

        {/* The card is the hub. Everything business-scoped lives here. */}
        <Route path="card/:id" element={<CardLayout />}>
          <Route index                 element={<OverviewTab />} />
          <Route path="card"           element={<CardTab />} />
          <Route path="voice"          element={<GreetingPage />} />
          <Route path="studio"         element={<VoiceStudioPage />} />
          <Route path="playground"     element={<PlaygroundPage />} />
          <Route path="campaigns"      element={<CampaignPage />} />
          <Route path="leads"          element={<LeadHunterPage />} />
          <Route path="pipeline"       element={<SalesPipelinePage />} />
          <Route path="schedule"       element={<SchedulePage />} />
          <Route path="intel"          element={<IntelPage />} />
          <Route path="approvals"      element={<ApprovalsPage scoped />} />
          <Route path="site"           element={<SiteTab />} />
          <Route path="history"        element={<HistoryTab />} />
        </Route>

        {/* Legacy routes from the tool-centric IA */}
        <Route path="company/:id" element={<LegacyCompany />} />
        <Route path="leads"       element={<Navigate to="/" replace />} />
        <Route path="pipeline"    element={<Navigate to="/" replace />} />
        <Route path="campaigns"   element={<Navigate to="/" replace />} />
        <Route path="schedule"    element={<Navigate to="/" replace />} />
        <Route path="intel"       element={<Navigate to="/" replace />} />
        <Route path="playground"  element={<Navigate to="/" replace />} />
        <Route path="greeting"    element={<Navigate to="/" replace />} />
        <Route path="voice-studio" element={<Navigate to="/" replace />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
