import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { siteLabel } from '../lib/ops'
import type { DutySlot, DutyType } from '../types'
import Toast from '../components/Toast'

const DAY_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'] // 0=Sun..6=Sat

export default function DutySlotsAdmin() {
  const { token, logout } = useAuth()
  const { sites, siteTypesById, employees } = useData()
  const activeSites = sites.filter((s) => s.is_active !== false)

  const [slots, setSlots] = useState<DutySlot[]>([])
  const [dutyTypes, setDutyTypes] = useState<DutyType[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')

  const [editingId, setEditingId] = useState<string | null>(null)
  const [site, setSite] = useState('')
  const [dType, setDType] = useState('')
  const [label, setLabel] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [days, setDays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6]))
  const [count, setCount] = useState('1')
  const [workers, setWorkers] = useState<Set<string>>(new Set())

  const guard = (m: string) => { if (m.includes('session')) logout(); else setErr(m) }

  const load = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const [s, dt] = await Promise.all([
      supabase.rpc('admin_list_duty_slots', { session_token: token }),
      supabase.rpc('admin_list_duty_types', { session_token: token }),
    ])
    setLoading(false)
    if (s.error) return logout()
    setSlots((s.data as DutySlot[]) ?? [])
    setDutyTypes((dt.data as DutyType[]) ?? [])
  }, [token, logout])

  useEffect(() => { void load() }, [load])

  function resetForm() {
    setEditingId(null); setSite(''); setDType(''); setLabel(''); setStart(''); setEnd('')
    setDays(new Set([0, 1, 2, 3, 4, 5, 6])); setCount('1'); setWorkers(new Set()); setErr('')
  }
  function editSlot(sl: DutySlot) {
    setEditingId(sl.id); setSite(sl.site_id); setDType(sl.duty_type_id); setLabel(sl.label ?? '')
    setStart((sl.start_time ?? '').slice(0, 5)); setEnd((sl.end_time ?? '').slice(0, 5))
    setDays(new Set(sl.weekdays)); setCount(String(sl.worker_count)); setWorkers(new Set(sl.eligible_worker_ids))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const toggleDay = (d: number) => setDays((s) => { const n = new Set(s); if (n.has(d)) n.delete(d); else n.add(d); return n })
  const toggleWorker = (id: string) => setWorkers((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  async function save() {
    if (!token) return
    if (!site || !dType) return setErr('בחר אתר וסוג משמרת')
    if (!start || !end) return setErr('מלא שעת התחלה וסיום')
    if (days.size === 0) return setErr('בחר לפחות יום אחד')
    const res = await supabase.rpc('admin_save_duty_slot', {
      session_token: token, id: editingId, site_id: site, duty_type_id: dType, label: label.trim() || null,
      start_time: start, end_time: end, weekdays: [...days].sort(), worker_count: Number(count) || 1, is_active: true,
    })
    if (res.error) return guard(res.error.message)
    const newId = res.data as string
    const w = await supabase.rpc('admin_set_duty_slot_workers', { session_token: token, duty_slot_id: newId, employee_ids: [...workers] })
    if (w.error) return guard(w.error.message)
    setToast(editingId ? 'נשמר' : 'נוסף סלוט'); resetForm(); void load()
  }

  async function remove(sl: DutySlot) {
    if (!token) return
    if (!window.confirm(`למחוק את הסלוט "${sl.label ?? sl.site_id}"?`)) return
    const { error } = await supabase.rpc('admin_delete_duty_slot', { session_token: token, id: sl.id })
    if (error) return guard(error.message)
    setToast('נמחק'); void load()
  }

  const typeLabel = (id: string) => dutyTypes.find((t) => t.id === id)?.label ?? '—'
  const siteTxt = (id: string) => siteLabel(sites.find((s) => s.id === id), id, siteTypesById)

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="card">
        <h2>{editingId ? 'עריכת סלוט משמרת' : 'סלוט משמרת חדש'}</h2>
        <label>אתר</label>
        <select value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">— בחר —</option>
          {activeSites.map((s) => <option key={s.id} value={s.id}>{siteLabel(s, s.id, siteTypesById)}</option>)}
        </select>
        <label>סוג משמרת</label>
        <select value={dType} onChange={(e) => setDType(e.target.value)}>
          <option value="">— בחר —</option>
          {dutyTypes.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <label>תווית (רשות)</label>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="לדוגמה: שמירת לילה" />
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}><label>התחלה</label><input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div style={{ flex: 1 }}><label>סיום</label><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </div>
        <label>ימים</label>
        <div className="asset-pick">
          {DAY_HE.map((d, i) => (
            <button key={i} type="button" className={`pick-chip ${days.has(i) ? 'on' : ''}`} onClick={() => toggleDay(i)}>{d}</button>
          ))}
        </div>
        <label>כמה עובדים להגריל לכל משמרת</label>
        <input type="number" min={1} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
        <label>עובדים כשירים (ריק = כל הפעילים)</label>
        <div className="asset-pick">
          {employees.map((w) => (
            <button key={w.id} type="button" className={`pick-chip ${workers.has(w.id) ? 'on' : ''}`} onClick={() => toggleWorker(w.id)}>
              {w.name}{w.role === 'admin' ? ' (מנהל)' : ''}
            </button>
          ))}
        </div>
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          {editingId && <button className="btn ghost" onClick={resetForm}>ביטול</button>}
          <button className="btn" onClick={() => void save()}>{editingId ? 'שמור שינויים' : 'הוסף סלוט'}</button>
        </div>
      </div>

      <div className="card">
        <h2>סלוטים קבועים ({slots.length})</h2>
        {slots.map((sl) => (
          <div className={`emp-row ${sl.is_active ? '' : 'inactive'}`} key={sl.id}>
            <div className="emp-row-head"><strong>{sl.label || typeLabel(sl.duty_type_id)}</strong></div>
            <div className="task-card-meta">
              <span>{siteTxt(sl.site_id)}</span>
              <span>{typeLabel(sl.duty_type_id)}</span>
              <span>{(sl.start_time ?? '').slice(0, 5)}–{(sl.end_time ?? '').slice(0, 5)}</span>
              <span>ימים: {sl.weekdays.map((d) => DAY_HE[d]).join(' ')}</span>
              <span>עובדים: {sl.worker_count}</span>
            </div>
            <div className="emp-row-actions" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => editSlot(sl)}>ערוך</button>
              <button className="btn sm danger" onClick={() => void remove(sl)}>מחק</button>
            </div>
          </div>
        ))}
      </div>
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
