import { useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { DataProvider, useData } from './context/DataContext'
import BottomNav, { type Tab } from './components/BottomNav'
import Login from './screens/Login'
import Tasks from './screens/Tasks'
import Create from './screens/Create'
import History from './screens/History'
import Employees from './screens/Employees'
import LoginAttempts from './screens/LoginAttempts'

function Shell() {
  const { session, logout } = useAuth()
  const { error } = useData()
  const [tab, setTab] = useState<Tab>('tasks')

  if (!session) return <Login />

  // Operators can't reach admin-only screens.
  const adminOnly: Tab[] = ['create', 'employees', 'attempts']
  const activeTab: Tab = adminOnly.includes(tab) && session.role !== 'admin' ? 'tasks' : tab

  return (
    <>
      <div className="app">
        <header className="app-header">
          <h1>OPS Dashboard</h1>
          <div className="who">
            <span className={`role-badge role-${session.role}`}>
              {session.role === 'admin' ? 'מנהל' : 'מפעיל'}
            </span>
            <button className="chip" onClick={logout} style={{ padding: '6px 10px' }}>
              {session.name} · יציאה
            </button>
          </div>
        </header>

        {error && <div className="error-banner">שגיאת חיבור: {error}</div>}

        {activeTab === 'tasks' && <Tasks />}
        {activeTab === 'create' && <Create />}
        {activeTab === 'history' && <History />}
        {activeTab === 'employees' && <Employees />}
        {activeTab === 'attempts' && <LoginAttempts />}
      </div>
      <BottomNav tab={activeTab} role={session.role} onChange={setTab} />
    </>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <DataProvider>
        <Shell />
      </DataProvider>
    </AuthProvider>
  )
}
