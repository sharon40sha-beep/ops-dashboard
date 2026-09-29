import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../utils/supabase'
import type { ChecklistTemplate, ChecklistTemplateItem } from '../types'
import Toast from '../components/Toast'
import DeleteAction from '../components/DeleteAction'

export default function ChecklistAdmin() {
  const { token, logout } = useAuth()
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([])
  const [selected, setSelected] = useState<ChecklistTemplate | null>(null)
  const [items, setItems] = useState<ChecklistTemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')

  const [addTpl, setAddTpl] = useState('')
  const [addLabel, setAddLabel] = useState('')
  const [addCritical, setAddCritical] = useState(false)
  const [addSort, setAddSort] = useState('')

  const guard = (m: string) => {
    if (m.includes('session')) logout()
    else setErr(m)
  }

  const loadTemplates = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_templates', { session_token: token })
    setLoading(false)
    if (error) return logout()
    setTemplates((data as ChecklistTemplate[]) ?? [])
  }, [token, logout])

  const loadItems = useCallback(
    async (tplId: string) => {
      if (!token) return
      const { data, error } = await supabase.rpc('admin_list_checklist_items', { session_token: token, template_id: tplId })
      if (error) return guard(error.message)
      setItems((data as ChecklistTemplateItem[]) ?? [])
    },
    [token], // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    void loadTemplates()
  }, [loadTemplates])

  useEffect(() => {
    if (selected) void loadItems(selected.id)
  }, [selected, loadItems])

  // ---- templates ----
  function patchTpl(id: string, patch: Partial<ChecklistTemplate>) {
    setTemplates((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }
  async function addTemplate() {
    if (!token || addTpl.trim() === '') return
    const { error } = await supabase.rpc('admin_add_template', { session_token: token, name: addTpl.trim() })
    if (error) return guard(error.message)
    setAddTpl('')
    setToast('נוספה תבנית')
    void loadTemplates()
  }
  async function saveTpl(t: ChecklistTemplate) {
    if (!token) return
    const { error } = await supabase.rpc('admin_update_template', {
      session_token: token, id: t.id, name: t.name.trim(), is_active: t.is_active,
    })
    if (error) return guard(error.message)
    setToast('נשמר')
    void loadTemplates()
  }

  // ---- items (within selected template) ----
  function patchItem(id: string, patch: Partial<ChecklistTemplateItem>) {
    setItems((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  async function addItem() {
    if (!token || !selected || addLabel.trim() === '') return
    const { error } = await supabase.rpc('admin_add_checklist_item', {
      session_token: token, template_id: selected.id, label: addLabel.trim(),
      critical: addCritical, sort_order: addSort === '' ? items.length + 1 : Number(addSort),
    })
    if (error) return guard(error.message)
    setAddLabel(''); setAddCritical(false); setAddSort('')
    setToast('נוסף סעיף')
    void loadItems(selected.id)
  }
  async function saveItem(it: ChecklistTemplateItem) {
    if (!token) return
    const { error } = await supabase.rpc('admin_update_checklist_item', {
      session_token: token, id: it.id, label: it.label.trim(),
      critical: it.critical, sort_order: it.sort_order, is_active: it.is_active,
    })
    if (error) return guard(error.message)
    setToast('נשמר')
    if (selected) void loadItems(selected.id)
  }

  if (loading) return <div className="center-screen">טוען…</div>

  // -------- items view (a template is selected) --------
  if (selected) {
    return (
      <div>
        <button className="btn secondary" style={{ marginTop: 0, marginBottom: 12 }} onClick={() => setSelected(null)}>
          ‹ תבניות
        </button>
        <div className="card">
          <h2>הוספת סעיף לתבנית "{selected.name}"</h2>
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
          <button className="btn" onClick={() => void addItem()} disabled={addLabel.trim() === ''}>הוסף סעיף</button>
        </div>

        <div className="card">
          <h2>סעיפים ({items.length})</h2>
          <p className="muted">"קריטי" הדגשה בלבד. "העבר לארכיון" = ביטול פעיל (לא ייכנס לנסיעות חדשות, לא נמחק).</p>
          {items.map((r) => (
            <div className={`emp-row ${r.is_active ? '' : 'inactive'}`} key={r.id}>
              <input type="text" value={r.label} onChange={(e) => patchItem(r.id, { label: e.target.value })} style={{ marginBottom: 8 }} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="inline-check">
                  <input type="checkbox" checked={r.critical} onChange={(e) => patchItem(r.id, { critical: e.target.checked })} />
                  <span>קריטי</span>
                </label>
                <div className="inline-check">
                  <span>סדר</span>
                  <input type="number" inputMode="numeric" value={r.sort_order} onChange={(e) => patchItem(r.id, { sort_order: Number(e.target.value) })} style={{ width: 60 }} />
                </div>
                <button className="btn sm ghost" onClick={() => { patchItem(r.id, { is_active: !r.is_active }); void saveItem({ ...r, is_active: !r.is_active }) }}>
                  {r.is_active ? 'לארכיון' : 'שחזר'}
                </button>
                <DeleteAction label={`סעיף "${r.label}"`} small
                  run={(reason, pin) => supabase.rpc('admin_delete_checklist_item', { session_token: token, actor_pin: pin, id: r.id, reason })}
                  onDone={() => selected && void loadItems(selected.id)} />
                <button className="btn sm" onClick={() => void saveItem(r)} style={{ marginInlineStart: 'auto' }}>שמור</button>
              </div>
            </div>
          ))}
        </div>
        {toast && <Toast message={toast} onDone={() => setToast('')} />}
      </div>
    )
  }

  // -------- templates list --------
  return (
    <div>
      <div className="card">
        <h2>הוספת תבנית</h2>
        <label>שם התבנית</label>
        <input type="text" value={addTpl} onChange={(e) => setAddTpl(e.target.value)} placeholder="לדוגמה: תבנית מוצר A1" />
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn" onClick={() => void addTemplate()} disabled={addTpl.trim() === ''}>הוסף תבנית</button>
      </div>

      <div className="card">
        <h2>תבניות ({templates.length})</h2>
        {templates.map((t) => (
          <div className={`emp-row ${t.is_active ? '' : 'inactive'}`} key={t.id}>
            <input type="text" value={t.name} onChange={(e) => patchTpl(t.id, { name: e.target.value })} style={{ marginBottom: 8 }} />
            <div className="emp-row-actions">
              <button className="btn sm ghost" onClick={() => { patchTpl(t.id, { is_active: !t.is_active }); void saveTpl({ ...t, is_active: !t.is_active }) }}>
                {t.is_active ? 'לארכיון' : 'שחזר'}
              </button>
              <button className="btn sm" onClick={() => void saveTpl(t)}>שמור שם</button>
              <DeleteAction label={`תבנית "${t.name}"`} small
                run={(reason, pin) => supabase.rpc('admin_delete_checklist_template', { session_token: token, actor_pin: pin, id: t.id, reason })}
                onDone={() => void loadTemplates()} />
              <button className="btn sm" onClick={() => setSelected(t)}>נהל סעיפים ›</button>
            </div>
          </div>
        ))}
      </div>
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
