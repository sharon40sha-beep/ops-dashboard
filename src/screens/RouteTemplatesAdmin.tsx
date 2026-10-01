import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import type { RouteTemplate } from '../types'
import Toast from '../components/Toast'

interface DraftSegment { route_id: string; checkpoint_note: string }

export default function RouteTemplatesAdmin() {
  const { token, logout } = useAuth()
  const { routes, entryPoints } = useData()
  const activeRoutes = routes.filter((r) => r.is_active)
  const activeEntries = entryPoints.filter((e) => e.is_active)

  const [list, setList] = useState<RouteTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')

  // form (new or editing)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [entryId, setEntryId] = useState('')
  const [segments, setSegments] = useState<DraftSegment[]>([{ route_id: '', checkpoint_note: '' }])

  const guard = (m: string) => { if (m.includes('session')) logout(); else setErr(m) }

  const load = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_route_templates', { session_token: token })
    setLoading(false)
    if (error) return logout()
    setList((data as RouteTemplate[]) ?? [])
  }, [token, logout])

  useEffect(() => { void load() }, [load])

  function resetForm() {
    setEditingId(null); setName(''); setEntryId(''); setSegments([{ route_id: '', checkpoint_note: '' }]); setErr('')
  }
  function editTemplate(t: RouteTemplate) {
    setEditingId(t.id); setName(t.name); setEntryId(t.entry_point_id ?? '')
    setSegments(t.segments.length > 0 ? t.segments.map((s) => ({ route_id: s.route_id ?? '', checkpoint_note: s.checkpoint_note ?? '' })) : [{ route_id: '', checkpoint_note: '' }])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function setSeg(i: number, patch: Partial<DraftSegment>) { setSegments((l) => l.map((s, idx) => (idx === i ? { ...s, ...patch } : s))) }
  function addSeg() { setSegments((l) => [...l, { route_id: '', checkpoint_note: '' }]) }
  function removeSeg(i: number) { setSegments((l) => (l.length <= 1 ? l : l.filter((_, idx) => idx !== i))) }

  async function remove(t: RouteTemplate) {
    if (!token) return
    if (!window.confirm(`למחוק את תבנית המסלול "${t.name}"?`)) return
    const { error } = await supabase.rpc('admin_delete_route_template', { session_token: token, id: t.id })
    if (error) return guard(error.message)
    setToast('נמחק'); void load()
  }

  async function save() {
    if (!token) return
    if (name.trim() === '') return setErr('הזן שם תבנית')
    const clean = segments.filter((s) => s.route_id.trim() !== '')
      .map((s, i) => ({ sequence: i + 1, route_id: s.route_id, checkpoint_note: s.checkpoint_note.trim() || null }))
    if (clean.length === 0) return setErr('הוסף לפחות קטע אחד')
    const { error } = await supabase.rpc('admin_save_route_template', {
      session_token: token, id: editingId, name: name.trim(), entry_point_id: entryId || null, is_active: true, segments: clean,
    })
    if (error) return guard(error.message)
    setToast(editingId ? 'נשמר' : 'נוספה תבנית'); resetForm(); void load()
  }

  const entryLabel = (id: string | null) => {
    const e = entryPoints.find((x) => x.id === id)
    return e ? `${e.site_id} · ${e.label}` : '—'
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="card">
        <h2>{editingId ? 'עריכת תבנית מסלול' : 'תבנית מסלול חדשה'}</h2>
        <label>שם</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="לדוגמה: מסלול רגיל" />

        <label>שער כניסה ביעד</label>
        <select value={entryId} onChange={(e) => setEntryId(e.target.value)}>
          <option value="">— ללא —</option>
          {activeEntries.map((ep) => <option key={ep.id} value={ep.id}>{ep.site_id} · {ep.label}</option>)}
        </select>

        <label>קטעי מסלול (לפי סדר)</label>
        <div className="seg-list">
          {segments.map((s, i) => (
            <div className="seg-row" key={i}>
              <span className="seg-num">{i + 1}</span>
              <select value={s.route_id} onChange={(e) => setSeg(i, { route_id: e.target.value })}>
                <option value="">— ציר —</option>
                {activeRoutes.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
              </select>
              <input type="text" value={s.checkpoint_note} placeholder="נקודת ציון (רשות)" onChange={(e) => setSeg(i, { checkpoint_note: e.target.value })} />
              {segments.length > 1 && <button type="button" className="btn sm ghost" onClick={() => removeSeg(i)}>✕</button>}
            </div>
          ))}
        </div>
        <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} onClick={addSeg}>+ הוסף קטע</button>

        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          {editingId && <button className="btn ghost" onClick={resetForm}>ביטול</button>}
          <button className="btn" onClick={() => void save()}>{editingId ? 'שמור שינויים' : 'הוסף תבנית'}</button>
        </div>
      </div>

      <div className="card">
        <h2>תבניות מסלול ({list.length})</h2>
        {list.map((t) => (
          <div className={`emp-row ${t.is_active ? '' : 'inactive'}`} key={t.id}>
            <div className="emp-row-head">
              <strong>{t.name}</strong>
            </div>
            <div className="task-card-meta">
              <span>ציר: <strong>{t.segments.map((s) => s.route_id).filter(Boolean).join(' → ') || '—'}</strong></span>
              <span>שער: {entryLabel(t.entry_point_id)}</span>
            </div>
            <div className="emp-row-actions" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => editTemplate(t)}>ערוך</button>
              <button className="btn sm danger" onClick={() => void remove(t)}>מחק</button>
            </div>
          </div>
        ))}
      </div>
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
