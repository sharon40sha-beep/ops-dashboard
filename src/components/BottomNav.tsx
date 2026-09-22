import type { Role } from '../types'

export type Tab = 'tasks' | 'create' | 'history' | 'employees'

const TABS: { id: Tab; label: string; icon: string; adminOnly?: boolean }[] = [
  { id: 'tasks', label: 'משימות', icon: '☑️' },
  { id: 'create', label: 'יצירה', icon: '➕', adminOnly: true },
  { id: 'history', label: 'היסטוריה', icon: '🗂️' },
  { id: 'employees', label: 'עובדים', icon: '👤', adminOnly: true },
]

export default function BottomNav({
  tab,
  role,
  onChange,
}: {
  tab: Tab
  role: Role
  onChange: (t: Tab) => void
}) {
  const tabs = TABS.filter((t) => (t.adminOnly ? role === 'admin' : true))
  return (
    <nav className="bottom-nav">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={t.id === tab ? 'active' : ''}
          onClick={() => onChange(t.id)}
          aria-label={t.label}
        >
          <span className="icon">{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
