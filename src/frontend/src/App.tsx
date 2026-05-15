import { Routes, Route } from 'react-router'
import { Home } from './pages/Home'
import { SupervisorPanel } from './components/SupervisorPanel'

export function App() {
  return (
    <Routes>
      <Route path="/supervisor" element={<div className="p-4 max-w-4xl mx-auto"><SupervisorPanel /></div>} />
      <Route path="/*" element={<Home />} />
    </Routes>
  )
}
