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
  const [addTpls, setAddTpls] = useState<Set<string>>(new Set())

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

  async function addType() {
    if (!token || addLabel.trim() === '') return
    const { error } = await supabase.rpc('admin_add_duty_type', {
      session_token: token, label: addLabel.trim(), template_ids: [...addTpls],
    })
    if (error) return guard(error.message)
    setAddLabel(''); setAddTpls(new Set()); setToast('נוסף'); void load()
  }

  async function saveLabel(t: DutyType) {
    if (!token) return
    const { error } = await supabase.rpc('admin_update_duty_type', {
      session_token: token, id: t.id, label: t.label.trim(), is_active: t.is_active,
    })
    if (error) return guard(error.message)
    setToast('נשמר'); void load()
  }

  async function toggleTemplate(t: DutyType, tid: string) {
    if (!token) return
    const next = t.template_ids.includes(tid) ? t.template_ids.filter((x) => x !== tid) : [...t.template_ids, tid]
    setTypes((ts) => ts.map((x) => (x.id === t.id ? { ...x, template_ids: next } : x)))
    const { error } = await supabase.rpc('admin_set_duty_type_templates', { session_token: token, duty_type_id: t.id, template_ids: next })
    if (error) return guard(error.message)
    setToast('תבניות נשמרו')
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="card">
        <h2>הוספת סוג משמרת</h2>
        <label>שם</label>
        <input type="text" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} placeholder="לדוגמה: שמירת לילה" />
        <label>תבניות צ׳קליסט (אפשר כמה)</label>
        <div className="asset-pick">
          {templates.filter((t) => t.is_active).length === 0 && <p className="muted">אין תבניות פעילות</p>}
          {templates.filter((t) => t.is_active).map((t) => (
            <button key={t.id} type="button" className={`pick-chip ${addTpls.has(t.id) ? 'on' : ''}`}
              onClick={() => setAddTpls((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n })}>
              {t.name}
            </button>
          ))}
        </div>
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn" onClick={() => void addType()} disabled={addLabel.trim() === ''}>הוסף</button>
      </div>

      <div className="card">
        <h2>סוגי משמרת ({types.length})</h2>
        {types.map((t) => (
          <div className={`emp-row ${t.is_active ? '' : 'inactive'}`} key={t.id}>
            <input type="text" value={t.label}
              onChange={(e) => setTypes((ts) => ts.map((x) => (x.id === t.id ? { ...x, label: e.target.value } : x)))}
              style={{ marginBottom: 8 }} />
            <div className="emp-row-actions" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm ghost" onClick={() => { const n = { ...t, is_active: !t.is_active }; setTypes((ts) => ts.map((x) => x.id === t.id ? n : x)); void saveLabel(n) }}>
                {t.is_active ? 'לארכיון' : 'שחזר'}
              </button>
              <button className="btn sm" onClick={() => void saveLabel(t)}>שמור שם</button>
              <DeleteAction label={`סוג משמרת "${t.label}"`} small
                run={(reason, pin) => supabase.rpc('admin_delete_duty_type', { session_token: token, actor_pin: pin, id: t.id, reason })}
                onDone={() => void load()} />
            </div>
            <div style={{ marginTop: 8 }}>
              <span className="muted" style={{ fontSize: 13 }}>תבניות צ׳קליסט (נשמר אוטומטית):</span>
              <div className="asset-pick" style={{ marginTop: 6 }}>
                {templates.filter((x) => x.is_active || t.template_ids.includes(x.id)).map((x) => (
                  <button key={x.id} type="button" className={`pick-chip ${t.template_ids.includes(x.id) ? 'on' : ''}`}
                    onClick={() => void toggleTemplate(t, x.id)}>
                    {x.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
