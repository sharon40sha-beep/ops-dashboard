import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../utils/supabase'
import type { ChecklistTemplate, DutyType } from '../types'
import Toast from '../components/Toast'
import DeleteAction from '../components/DeleteAction'

export default function DutyTypesAdmin() {
  const { token, logout } = useAuth()
  const [types, setTypes] = useState<DutyType[]>([])
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')
  const [addLabel, setAddLabel] = useState('')
  const [addTpl, setAddTpl] = useState('')

  const guard = (m: string) => { if (m.includes('session')) logout(); else setErr(m) }

  const load = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const [t, tp] = await Promise.all([
      supabase.rpc('admin_list_duty_types', { session_token: token }),
      supabase.rpc('admin_list_templates', { session_token: token }),
    ])
    setLoading(false)
    if (t.error) return logout()
    setTypes((t.data as DutyType[]) ?? [])
    setTemplates((tp.data as ChecklistTemplate[]) ?? [])
  }, [token, logout])

  useEffect(() => { void load() }, [load])

  function patch(id: string, p: Partial<DutyType>) {
    setTypes((ts) => ts.map((x) => (x.id === id ? { ...x, ...p } : x)))
  }

  async function addType() {
    if (!token || addLabel.trim() === '') return
    const { error } = await supabase.rpc('admin_add_duty_type', {
      session_token: token, label: addLabel.trim(), checklist_template_id: addTpl || null,
    })
    if (error) return guard(error.message)
    setAddLabel(''); setAddTpl(''); setToast('נוסף'); void load()
  }

  async function save(t: DutyType) {
    if (!token) return
    const { error } = await supabase.rpc('admin_update_duty_type', {
      session_token: token, id: t.id, label: t.label.trim(),
      checklist_template_id: t.checklist_template_id, is_active: t.is_active,
    })
    if (error) return guard(error.message)
    setToast('נשמר'); void load()
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="card">
        <h2>הוספת סוג משמרת</h2>
        <label>שם</label>
        <input type="text" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} placeholder="לדוגמה: שמירת לילה" />
        <label>תבנית צ׳קליסט</label>
        <select value={addTpl} onChange={(e) => setAddTpl(e.target.value)}>
          <option value="">— ללא —</option>
          {templates.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn" onClick={() => void addType()} disabled={addLabel.trim() === ''}>הוסף</button>
      </div>

      <div className="card">
        <h2>סוגי משמרת ({types.length})</h2>
        {types.map((t) => (
          <div className={`emp-row ${t.is_active ? '' : 'inactive'}`} key={t.id}>
            <input type="text" value={t.label} onChange={(e) => patch(t.id, { label: e.target.value })} style={{ marginBottom: 8 }} />
            <div className="emp-row-actions" style={{ flexWrap: 'wrap' }}>
              <select value={t.checklist_template_id ?? ''} onChange={(e) => patch(t.id, { checklist_template_id: e.target.value || null })}>
                <option value="">— ללא תבנית —</option>
                {templates.filter((x) => x.is_active || x.id === t.checklist_template_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <button className="btn sm ghost" onClick={() => { patch(t.id, { is_active: !t.is_active }); void save({ ...t, is_active: !t.is_active }) }}>
                {t.is_active ? 'לארכיון' : 'שחזר'}
              </button>
              <button className="btn sm" onClick={() => void save(t)}>שמור</button>
              <DeleteAction label={`סוג משמרת "${t.label}"`} small
                run={(reason, pin) => supabase.rpc('admin_delete_duty_type', { session_token: token, actor_pin: pin, id: t.id, reason })}
                onDone={() => void load()} />
            </div>
          </div>
        ))}
      </div>
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
