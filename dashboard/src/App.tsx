import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { DashboardPage }  from './pages/DashboardPage'
import { OnboardPage }    from './pages/OnboardPage'
import { CompanyPage }    from './pages/CompanyPage'
import { GreetingPage }   from './pages/GreetingPage'
import { ApprovalsPage }  from './pages/ApprovalsPage'
import { PlaygroundPage } from './pages/PlaygroundPage'

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
      </Route>
    </Routes>
  )
}
