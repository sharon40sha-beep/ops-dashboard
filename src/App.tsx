import { useState } from 'react'
import { AuthProvider, useAuth } from './context/AuthContext'
import { DataProvider, useData } from './context/DataContext'
import BottomNav, { type Tab } from './components/BottomNav'
import Login from './screens/Login'
import Tasks from './screens/Tasks'
import Create from './screens/Create'
import History from './screens/History'
import AdminHub from './screens/AdminHub'

export type EditTarget = { kind: 'trip' | 'duty'; id: string }

function Shell() {
  const { session, logout } = useAuth()
  const { error } = useData()
  const [tab, setTab] = useState<Tab>('tasks')
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)

  if (!session) return <Login />

  // Operators can't reach admin-only screens.
  const adminOnly: Tab[] = ['create', 'admin']
  const activeTab: Tab = adminOnly.includes(tab) && session.role !== 'admin' ? 'tasks' : tab

  // open the create form pre-filled to edit a planned task
  const startEdit = (t: EditTarget) => { setEditTarget(t); setTab('create') }
  // manual navigation always leaves edit mode
  const navigate = (t: Tab) => { setEditTarget(null); setTab(t) }

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

        {activeTab === 'tasks' && <Tasks onEdit={startEdit} />}
        {activeTab === 'create' && (
          <Create editTarget={editTarget} onDone={() => navigate('tasks')} />
        )}
        {activeTab === 'history' && <History />}
        {activeTab === 'admin' && <AdminHub />}
      </div>
      <BottomNav tab={activeTab} role={session.role} onChange={navigate} />
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
