import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../utils/supabase'
import { fmtDateTime } from '../lib/ops'
import type { DeletionLogEntry } from '../types'

const TYPE_HE: Record<string, string> = {
  trip: 'נסיעה',
  duty_shift: 'משמרת',
  asset: 'מוצר',
  site: 'אתר',
  route: 'ציר',
  vehicle: 'רכב',
  checklist_item: 'סעיף צ׳קליסט',
  checklist_template: 'תבנית צ׳קליסט',
  duty_type: 'סוג משמרת',
}

function shortDesc(e: DeletionLogEntry): string {
  const s = e.snapshot ?? {}
  // best-effort human hint from the snapshot
  const parts: string[] = []
  if (typeof s.from_site_id === 'string' && typeof s.to_site_id === 'string') parts.push(`${s.from_site_id}←${s.to_site_id}`)
  if (typeof s.label === 'string') parts.push(s.label)
  if (typeof s.name === 'string') parts.push(s.name)
  if (e.entity_id) parts.push(e.entity_id.length > 10 ? e.entity_id.slice(0, 8) : e.entity_id)
  return parts.join(' · ')
}

export default function DeletionLog() {
  const { token, logout } = useAuth()
  const [rows, setRows] = useState<DeletionLogEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_deletion_log', { session_token: token, limit_count: 200 })
    setLoading(false)
    if (error) return logout()
    setRows((data as DeletionLogEntry[]) ?? [])
  }, [token, logout])

  useEffect(() => { void load() }, [load])

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="card">
        <div className="card-head-row">
          <h2 style={{ margin: 0 }}>יומן מחיקות ({rows.length})</h2>
          <button className="btn secondary sm" onClick={() => void load()}>רענן</button>
        </div>
        <p className="muted">רישום קבוע ובלתי-ניתן-למחיקה של כל מחיקה. תצוגה בלבד.</p>
        {rows.length === 0 && <p className="muted">אין רשומות.</p>}
        {rows.map((e) => (
          <div className="list-item" key={e.id}>
            <div>
              <div className="title">
                <span className="badge">{TYPE_HE[e.entity_type] ?? e.entity_type}</span> {shortDesc(e)}
              </div>
              <div className="sub">
                {fmtDateTime(e.deleted_at)} · {e.deleted_by_name ?? 'לא ידוע'}
                {e.reason ? ` · סיבה: ${e.reason}` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
