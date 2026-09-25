import { useState } from 'react'
import Employees from './Employees'
import LoginAttempts from './LoginAttempts'
import ChecklistAdmin from './ChecklistAdmin'
import Entities from './Entities'
import Summary from './Summary'

type Sub = 'menu' | 'employees' | 'attempts' | 'checklist' | 'entities' | 'summary'

const ITEMS: { id: Exclude<Sub, 'menu'>; label: string; icon: string; desc: string }[] = [
  { id: 'employees', label: 'עובדים', icon: '👤', desc: 'הוספה, סיסמאות, הרשאות, השבתה' },
  { id: 'entities', label: 'הגדרות מערכת', icon: '🏭', desc: 'מוצרים, אתרים, צירים, רכבים' },
  { id: 'checklist', label: 'תוכן צ׳קליסט', icon: '☑️', desc: 'סעיפי בדיקה וקריטיות' },
  { id: 'summary', label: 'לוח למידה', icon: '📊', desc: 'סיכום וניתוח לפי מוצר' },
  { id: 'attempts', label: 'לוג כניסות', icon: '🔐', desc: 'ניסיונות התחברות אחרונים' },
]

export default function AdminHub() {
  const [sub, setSub] = useState<Sub>('menu')

  if (sub === 'menu') {
    return (
      <div>
        <h1 className="screen-title" style={{ fontSize: 20, margin: '4px 0 14px' }}>ניהול</h1>
        <div className="hub-grid">
          {ITEMS.map((it) => (
            <button key={it.id} className="hub-card" onClick={() => setSub(it.id)}>
              <span className="hub-icon">{it.icon}</span>
              <span className="hub-label">{it.label}</span>
              <span className="hub-desc">{it.desc}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <button className="btn secondary" style={{ marginTop: 0, marginBottom: 12 }} onClick={() => setSub('menu')}>
        ‹ תפריט ניהול
      </button>
      {sub === 'employees' && <Employees />}
      {sub === 'attempts' && <LoginAttempts />}
      {sub === 'checklist' && <ChecklistAdmin />}
      {sub === 'entities' && <Entities />}
      {sub === 'summary' && <Summary />}
    </div>
  )
}
