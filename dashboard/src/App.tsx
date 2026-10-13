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
import { AiTab }       from './pages/card/AiTab'
import { StudioTab }   from './pages/card/StudioTab'
import { SettingsTab } from './pages/card/SettingsTab'
import { LeadsLayout } from './pages/leads/LeadsLayout'

/** /company/:id → /card/:id, preserving the id. */
function LegacyCompany() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={id ? `/card/${id}` : '/'} replace />
}

/** An old flat card tab → its new home inside the same card. */
function CardRedirect({ to }: { to: string }) {
  const { id = '' } = useParams<{ id: string }>()
  return <Navigate to={`/card/${id}/${to}`} replace />
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        {/* Global — the account-wide surfaces */}
        <Route index                   element={<DashboardPage />} />
        <Route path="onboard"          element={<OnboardPage />} />
        <Route path="approvals"        element={<ApprovalsPage />} />
        <Route path="settings"         element={<SettingsPage />} />
        <Route path="portfolio"        element={<PortfolioPage />} />
        <Route path="billing"          element={<BillingPage />} />

        {/* Leads — the ACCOUNT OWNER's own prospecting (finding new clients).
            Lives at the top level; it is not a card tab. */}
        <Route path="leads" element={<LeadsLayout />}>
          <Route index           element={<LeadHunterPage />} />
          <Route path="pipeline" element={<SalesPipelinePage />} />
          <Route path="schedule" element={<SchedulePage />} />
        </Route>

        {/* The card is the hub. Everything business-scoped lives here. */}
        <Route path="card/:id" element={<CardLayout />}>
          <Route index                 element={<OverviewTab />} />
          <Route path="card"           element={<CardTab />} />
          <Route path="site"           element={<SiteTab />} />
          <Route path="playground"     element={<PlaygroundPage />} />
          <Route path="campaigns"      element={<CampaignPage />} />
          <Route path="intel"          element={<IntelPage />} />

          {/* Studio — merged Voice + Studio. All card audio in one place. */}
          <Route path="studio" element={<StudioTab />}>
            <Route index        element={<GreetingPage />} />
            <Route path="audio" element={<VoiceStudioPage />} />
          </Route>

          {/* Settings — merged Approvals + AI + History. */}
          <Route path="settings" element={<SettingsTab />}>
            <Route index            element={<AiTab />} />
            <Route path="approvals" element={<ApprovalsPage scoped />} />
            <Route path="history"   element={<HistoryTab />} />
          </Route>

          {/* Old flat card tabs → their new homes (bookmarks keep working). */}
          <Route path="voice"     element={<CardRedirect to="studio" />} />
          <Route path="approvals" element={<CardRedirect to="settings/approvals" />} />
          <Route path="history"   element={<CardRedirect to="settings/history" />} />
          <Route path="leads"     element={<Navigate to="/leads" replace />} />
          <Route path="pipeline"  element={<Navigate to="/leads/pipeline" replace />} />
          <Route path="schedule"  element={<Navigate to="/leads/schedule" replace />} />
        </Route>

        {/* Legacy routes from the tool-centric IA */}
        <Route path="company/:id" element={<LegacyCompany />} />
        <Route path="pipeline"    element={<Navigate to="/leads/pipeline" replace />} />
        <Route path="schedule"    element={<Navigate to="/leads/schedule" replace />} />
        <Route path="campaigns"   element={<Navigate to="/" replace />} />
        <Route path="intel"       element={<Navigate to="/" replace />} />
        <Route path="playground"  element={<Navigate to="/" replace />} />
        <Route path="greeting"    element={<Navigate to="/" replace />} />
        <Route path="voice-studio" element={<Navigate to="/" replace />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
