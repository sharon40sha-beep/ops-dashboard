import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../utils/supabase'
import type { ChecklistTemplateItem } from '../types'
import Toast from '../components/Toast'

export default function ChecklistAdmin() {
  const { token, logout } = useAuth()
  const [rows, setRows] = useState<ChecklistTemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')

  // add form
  const [addLabel, setAddLabel] = useState('')
  const [addCritical, setAddCritical] = useState(false)
  const [addSort, setAddSort] = useState('')

  const load = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_checklist_items', { session_token: token })
    setLoading(false)
    if (error) return logout()
    setRows((data as ChecklistTemplateItem[]) ?? [])
  }, [token, logout])

  useEffect(() => {
    void load()
  }, [load])

  function patchLocal(id: string, patch: Partial<ChecklistTemplateItem>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  async function saveRow(item: ChecklistTemplateItem) {
    if (!token) return
    setErr('')
    const { error } = await supabase.rpc('admin_update_checklist_item', {
      session_token: token,
      id: item.id,
      label: item.label.trim(),
      critical: item.critical,
      sort_order: item.sort_order,
      is_active: item.is_active,
    })
    if (error) {
      if (error.message.includes('session')) return logout()
      setErr(error.message)
      return
    }
    setToast('נשמר')
    void load()
  }

  async function addItem() {
    if (!token || addLabel.trim() === '') return
    setErr('')
    const { error } = await supabase.rpc('admin_add_checklist_item', {
      session_token: token,
      label: addLabel.trim(),
      critical: addCritical,
      sort_order: addSort === '' ? rows.length + 1 : Number(addSort),
    })
    if (error) {
      if (error.message.includes('session')) return logout()
      setErr(error.message)
      return
    }
    setAddLabel('')
    setAddCritical(false)
    setAddSort('')
    setToast('נוסף')
    void load()
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="card">
        <h2>הוספת סעיף</h2>
        <label>טקסט הסעיף</label>
        <input type="text" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} placeholder="לדוגמה: נעילת דלתות" />
        <div style={{ display: 'flex', gap: 12, alignItems: 'end' }}>
          <div style={{ flex: 1 }}>
            <label>סדר</label>
            <input type="number" inputMode="numeric" value={addSort} onChange={(e) => setAddSort(e.target.value)} placeholder="אוטו" />
          </div>
          <label className="inline-check" style={{ flex: 1 }}>
            <input type="checkbox" checked={addCritical} onChange={(e) => setAddCritical(e.target.checked)} />
            <span>קריטי</span>
          </label>
        </div>
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn" onClick={() => void addItem()} disabled={addLabel.trim() === ''}>
          הוסף סעיף
        </button>
      </div>

      <div className="card">
        <h2>סעיפי צ׳קליסט ({rows.length})</h2>
        <p className="muted">"קריטי" הוא הדגשה בלבד — לא חוסם. סעיף מושבת לא ייכנס למשימות חדשות.</p>
        {rows.map((r) => (
          <div className={`emp-row ${r.is_active ? '' : 'inactive'}`} key={r.id}>
            <input
              type="text"
              value={r.label}
              onChange={(e) => patchLocal(r.id, { label: e.target.value })}
              style={{ marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="inline-check">
                <input type="checkbox" checked={r.critical} onChange={(e) => patchLocal(r.id, { critical: e.target.checked })} />
                <span>קריטי</span>
              </label>
              <label className="inline-check">
                <input type="checkbox" checked={r.is_active} onChange={(e) => patchLocal(r.id, { is_active: e.target.checked })} />
                <span>פעיל</span>
              </label>
              <div className="inline-check">
                <span>סדר</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={r.sort_order}
                  onChange={(e) => patchLocal(r.id, { sort_order: Number(e.target.value) })}
                  style={{ width: 64 }}
                />
              </div>
              <button className="btn sm" onClick={() => void saveRow(r)} style={{ marginInlineStart: 'auto' }}>
                שמור
              </button>
            </div>
          </div>
        ))}
      </div>

      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
