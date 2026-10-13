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

import { CardLayout }    from './pages/card/CardLayout'
import { OverviewTab }   from './pages/card/OverviewTab'
import { CardTab }       from './pages/card/CardTab'
import { SiteTab }       from './pages/card/SiteTab'
import { HistoryTab }    from './pages/card/HistoryTab'
import { AiTab }         from './pages/card/AiTab'
import { PlaygroundTab } from './pages/card/PlaygroundTab'
import { SettingsTab }   from './pages/card/SettingsTab'
import { LeadsLayout }   from './pages/leads/LeadsLayout'

/** /company/:id → /card/:id, preserving the id. */
function LegacyCompany() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={id ? `/card/${id}` : '/'} replace />
}

/** Redirect inside a card: /card/:id/<old> → /card/:id/<to>.
 *  Absolute (built from the route param) on purpose — a relative <Navigate to="playground">
 *  resolved against the ROOT here and landed on the global legacy /playground route → "/". */
function CardRedirect({ to }: { to: string }) {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={id ? `/card/${id}/${to}` : '/'} replace />
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

        {/* Leads — the ACCOUNT OWNER's client acquisition. Deliberately NOT a
            card tab: a card is a business you already serve; leads are the
            businesses you have not signed yet. */}
        <Route path="leads" element={<LeadsLayout />}>
          <Route index                 element={<LeadHunterPage />} />
          <Route path="pipeline"       element={<SalesPipelinePage />} />
          <Route path="schedule"       element={<SchedulePage />} />
        </Route>

        {/* The card is the hub. Everything business-scoped lives here. */}
        <Route path="card/:id" element={<CardLayout />}>
          <Route index                 element={<OverviewTab />} />
          <Route path="card"           element={<CardTab />} />
          {/* Playground = the old Voice + Studio + Playground tabs, merged. */}
          <Route path="playground"     element={<PlaygroundTab />}>
            <Route index               element={<GreetingPage />} />
            <Route path="audio"        element={<VoiceStudioPage />} />
            <Route path="lab"          element={<PlaygroundPage />} />
          </Route>
          <Route path="site"           element={<SiteTab />} />
          <Route path="campaigns"      element={<CampaignPage />} />
          <Route path="intel"          element={<IntelPage />} />
          <Route path="settings"       element={<SettingsTab />}>
            <Route index               element={<AiTab />} />
            <Route path="approvals"    element={<ApprovalsPage scoped />} />
            <Route path="history"      element={<HistoryTab />} />
          </Route>

          {/* The old flat tabs → their new section, so bookmarks keep working. */}
          <Route path="voice"          element={<CardRedirect to="playground" />} />
          <Route path="studio"         element={<CardRedirect to="playground" />} />
          <Route path="studio/audio"   element={<CardRedirect to="playground/audio" />} />
          <Route path="approvals"      element={<CardRedirect to="settings/approvals" />} />
          <Route path="history"        element={<CardRedirect to="settings/history" />} />
          <Route path="leads"          element={<Navigate to="/leads" replace />} />
          <Route path="pipeline"       element={<Navigate to="/leads/pipeline" replace />} />
          <Route path="schedule"       element={<Navigate to="/leads/schedule" replace />} />
        </Route>

        {/* Legacy routes from the tool-centric IA */}
        <Route path="company/:id" element={<LegacyCompany />} />
        <Route path="leads"       element={<Navigate to="/leads" replace />} />
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
