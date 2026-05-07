import { Navigate, Route, Routes } from 'react-router-dom'
import { useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import { ContractsPage } from './pages/ContractsPage'
import { ContractDetailPage } from './pages/ContractDetailPage'
import { SettingsPage } from './pages/SettingsPage'
import { UploadPage } from './pages/UploadPage'
import { getDevUserId } from './lib/devUser'

export default function App() {
  const [devUserId, setDevUser] = useState(getDevUserId())
  return <AppShell devUserId={devUserId}>
    {!devUserId && <div className='mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm'>Set a development user ID to call the local API.</div>}
    <Routes>
      <Route path='/' element={<Navigate to='/contracts' replace />} />
      <Route path='/contracts' element={<ContractsPage devUserId={devUserId} />} />
      <Route path='/contracts/:id' element={<ContractDetailPage devUserId={devUserId} />} />
      <Route path='/upload' element={<UploadPage devUserId={devUserId} />} />
      <Route path='/settings' element={<SettingsPage devUserId={devUserId} onSaved={setDevUser} />} />
    </Routes>
  </AppShell>
}
