import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import type { EditTarget } from '../App'
import type { TaskStatus, WeekItem, WeekGenResult } from '../types'

const STATUS_HE: Record<TaskStatus, string> = { planned: 'מתוכננת', active: 'פעילה', completed: 'הושלמה' }
const DAY_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
/** Sunday of the week containing `d` (Israel week starts Sunday). */
function weekStart(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - x.getDay())
  return x
}

export default function MyWeek({ onOpen }: { onOpen: (t: EditTarget) => void }) {
  const { session, token, logout } = useAuth()
  const { employees } = useData()
  const isAdmin = session?.role === 'admin'

  const [start, setStart] = useState<Date>(() => weekStart(new Date()))
  const [empId, setEmpId] = useState('') // admin: whose week (empty = me)
  const [items, setItems] = useState<WeekItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [gen, setGen] = useState<WeekGenResult | null>(null)
  const [generating, setGenerating] = useState(false)

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i); return d
  }), [start])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true); setErr('')
    const res = empId
      ? await supabase.rpc('list_week_for_employee', { session_token: token, employee_id: empId, week_start_date: iso(start) })
      : await supabase.rpc('list_my_week', { session_token: token, week_start_date: iso(start) })
    setLoading(false)
    if (res.error) { if (res.error.message.includes('session')) return logout(); setErr(res.error.message); return }
    setItems((res.data as WeekItem[]) ?? [])
  }, [token, empId, start, logout])

  useEffect(() => { void load() }, [load])

  const byDay = useMemo(() => {
    const m = new Map<string, WeekItem[]>()
    items.forEach((it) => {
      const k = it.scheduled_date?.slice(0, 10)
      if (!k) return
      const arr = m.get(k) ?? []
      arr.push(it); m.set(k, arr)
    })
    return m
  }, [items])

  function shift(weeks: number) {
    const d = new Date(start); d.setDate(start.getDate() + weeks * 7); setStart(weekStart(d))
  }

  async function generate() {
    if (!token) return
    if (!window.confirm(`לבנות (להגריל) את שבוע ${iso(start).split('-').reverse().join('/')}? משימות שכבר קיימות יידלגו.`)) return
    setGenerating(true); setGen(null); setErr('')
    const { data, error } = await supabase.rpc('admin_generate_week', { session_token: token, week_start_date: iso(start) })
    setGenerating(false)
    if (error) { if (error.message.includes('session')) return logout(); setErr(error.message); return }
    setGen(data as WeekGenResult)
    void load()
  }

  return (
    <div>
      <div className="card">
        <div className="week-head">
          <button className="btn sm ghost" onClick={() => shift(-1)}>‹ שבוע קודם</button>
          <strong>שבוע {iso(start).split('-').reverse().join('/')}</strong>
          <button className="btn sm ghost" onClick={() => shift(1)}>שבוע הבא ›</button>
        </div>
        {isAdmin && (
          <>
            <label>צפייה בשבוע של</label>
            <select value={empId} onChange={(e) => setEmpId(e.target.value)}>
              <option value="">— אני —</option>
              {employees.map((w) => <option key={w.id} value={w.id}>{w.name}{w.role === 'admin' ? ' (מנהל)' : ''}</option>)}
            </select>
          </>
        )}
        {isAdmin && (
          <button className="btn" onClick={() => void generate()} disabled={generating} style={{ marginTop: 12 }}>
            {generating ? 'מגריל…' : '🎲 בנה שבוע (הגרלה)'}
          </button>
        )}
        {gen && (
          <div className="reason-box" style={{ marginTop: 12 }}>
            נוצרו <strong>{gen.trips_created}</strong> נסיעות ו-<strong>{gen.duties_created}</strong> משמרות.
            {gen.note && <div style={{ color: 'var(--danger)', marginTop: 6 }}>{gen.note}</div>}
            {gen.skipped_assets.length > 0 && (
              <div style={{ marginTop: 6 }}>
                מוצרים שדולגו (חסרה תבנית מסלול): <strong>{gen.skipped_assets.join(', ')}</strong> — הגדר/י להם תבנית ב"הגדרות הגרלה".
              </div>
            )}
          </div>
        )}
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
      </div>

      {loading ? (
        <div className="center-screen">טוען…</div>
      ) : (
        <div className="week-grid">
          {days.map((d, i) => {
            const key = iso(d)
            const dayItems = byDay.get(key) ?? []
            const isToday = key === iso(new Date())
            return (
              <div className={`week-day ${isToday ? 'today' : ''}`} key={key}>
                <div className="week-day-head">
                  <span>{DAY_HE[i]}</span>
                  <span className="muted">{d.getDate()}/{d.getMonth() + 1}</span>
                </div>
                {dayItems.length === 0 && <div className="week-empty">—</div>}
                {dayItems.map((it) => (
                  <button key={`${it.type}-${it.id}`} className="week-item" onClick={() => onOpen({ kind: it.type, id: it.id })}>
                    <span className="week-item-top">
                      <span>{it.type === 'trip' ? '🚚' : '🛡️'}</span>
                      <span className={`status-pill status-${it.status}`}>{STATUS_HE[it.status]}</span>
                    </span>
                    <span className="week-item-label">{it.label || 'משימה'}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
