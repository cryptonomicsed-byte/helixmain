import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DashboardPage }     from './pages/DashboardPage'
import { OnboardPage }       from './pages/OnboardPage'
import { CompanyPage }       from './pages/CompanyPage'
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

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index                   element={<DashboardPage />} />
        <Route path="onboard"          element={<OnboardPage />} />
        <Route path="company/:id"      element={<CompanyPage />} />
        <Route path="greeting"         element={<GreetingPage />} />
        <Route path="approvals"        element={<ApprovalsPage />} />
        <Route path="playground"       element={<PlaygroundPage />} />
        <Route path="leads"            element={<LeadHunterPage />} />
        <Route path="pipeline"         element={<SalesPipelinePage />} />
        <Route path="intel"            element={<IntelPage />} />
        <Route path="campaigns"        element={<CampaignPage />} />
        <Route path="schedule"         element={<SchedulePage />} />
        <Route path="voice-studio"     element={<VoiceStudioPage />} />
        <Route path="portfolio"        element={<PortfolioPage />} />
      </Route>
    </Routes>
  )
}
