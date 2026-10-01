import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import type { AssetGenConfig, RouteTemplate } from '../types'
import Toast from '../components/Toast'

const DAY_HE = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']

interface Row {
  id: string
  weekdays: number[]
  gen_worker_count: number
  gen_vehicle_count: number
  workers: string[]
  vehicles: string[]
  templates: string[]
}

export default function AssetGenAdmin() {
  const { token, logout } = useAuth()
  const { employees, vehicles } = useData()
  const activeVehicles = vehicles.filter((v) => v.is_active)

  const [rows, setRows] = useState<Row[]>([])
  const [tpls, setTpls] = useState<RouteTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [err, setErr] = useState('')

  const guard = (m: string) => { if (m.includes('session')) logout(); else setErr(m) }

  const load = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const [g, rt] = await Promise.all([
      supabase.rpc('admin_list_asset_gen', { session_token: token }),
      supabase.rpc('admin_list_route_templates', { session_token: token }),
    ])
    setLoading(false)
    if (g.error) return logout()
    setRows(((g.data as AssetGenConfig[]) ?? []).map((c) => ({
      id: c.id, weekdays: c.weekdays ?? [], gen_worker_count: c.gen_worker_count, gen_vehicle_count: c.gen_vehicle_count,
      workers: c.eligible_worker_ids ?? [], vehicles: c.eligible_vehicle_ids ?? [], templates: c.route_template_ids ?? [],
    })))
    setTpls((rt.data as RouteTemplate[]) ?? [])
  }, [token, logout])

  useEffect(() => { void load() }, [load])

  function patch(id: string, p: Partial<Row>) { setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r))) }
  function toggleIn(arr: string[], v: string): string[] { return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v] }
  function toggleNum(arr: number[], v: number): number[] { return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v] }

  async function save(r: Row) {
    if (!token) return
    setErr('')
    const calls = await Promise.all([
      supabase.rpc('admin_set_asset_gen_counts', { session_token: token, asset_id: r.id, worker_count: r.gen_worker_count, vehicle_count: r.gen_vehicle_count }),
      supabase.rpc('admin_set_asset_weekdays', { session_token: token, asset_id: r.id, weekdays: [...r.weekdays].sort() }),
      supabase.rpc('admin_set_asset_eligible_workers', { session_token: token, asset_id: r.id, employee_ids: r.workers }),
      supabase.rpc('admin_set_asset_eligible_vehicles', { session_token: token, asset_id: r.id, vehicle_ids: r.vehicles }),
      supabase.rpc('admin_set_asset_route_templates', { session_token: token, asset_id: r.id, template_ids: r.templates }),
    ])
    const e = calls.find((c) => c.error)?.error
    if (e) return guard(e.message)
    setToast(`נשמר (${r.id})`)
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="card">
        <h2>הגדרות הגרלה למוצר</h2>
        <p className="muted">לכל מוצר: באילו ימים לייצר, כמה עובדים/רכבים להגריל, מי כשיר (ריק = כולם), ואילו תבניות מסלול תקפות. <strong>חובה לפחות תבנית מסלול אחת</strong> כדי שהמוצר ייכלל בהגרלה.</p>
      </div>
      {err && <div className="error-banner">{err}</div>}
      {rows.length === 0 && <div className="card"><p className="muted">אין מוצרים. הוסף מוצרים בניהול ישויות.</p></div>}
      {rows.map((r) => (
        <div className="card" key={r.id}>
          <div className="task-card-top"><span className="code">{r.id}</span>
            {r.templates.length === 0 && <span className="excl-tag">חסרה תבנית מסלול</span>}
          </div>

          <label>ימי עבודה</label>
          <div className="asset-pick">
            {DAY_HE.map((d, i) => (
              <button key={i} type="button" className={`pick-chip ${r.weekdays.includes(i) ? 'on' : ''}`} onClick={() => patch(r.id, { weekdays: toggleNum(r.weekdays, i) })}>{d}</button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label>עובדים להגריל</label>
              <input type="number" min={1} inputMode="numeric" value={r.gen_worker_count} onChange={(e) => patch(r.id, { gen_worker_count: Number(e.target.value) || 1 })} />
            </div>
            <div style={{ flex: 1 }}>
              <label>רכבים להגריל</label>
              <input type="number" min={0} inputMode="numeric" value={r.gen_vehicle_count} onChange={(e) => patch(r.id, { gen_vehicle_count: Number(e.target.value) || 0 })} />
            </div>
          </div>

          <label>תבניות מסלול תקפות *</label>
          <div className="asset-pick">
            {tpls.filter((t) => t.is_active).length === 0 && <p className="muted">אין תבניות מסלול — צור במסך "תבניות מסלול"</p>}
            {tpls.filter((t) => t.is_active).map((t) => (
              <button key={t.id} type="button" className={`pick-chip ${r.templates.includes(t.id) ? 'on' : ''}`} onClick={() => patch(r.id, { templates: toggleIn(r.templates, t.id) })}>{t.name}</button>
            ))}
          </div>

          <label>עובדים כשירים (ריק = כל הפעילים)</label>
          <div className="asset-pick">
            {employees.map((w) => (
              <button key={w.id} type="button" className={`pick-chip ${r.workers.includes(w.id) ? 'on' : ''}`} onClick={() => patch(r.id, { workers: toggleIn(r.workers, w.id) })}>{w.name}</button>
            ))}
          </div>

          <label>רכבים כשירים (ריק = כל הפעילים)</label>
          <div className="asset-pick">
            {activeVehicles.map((v) => (
              <button key={v.id} type="button" className={`pick-chip ${r.vehicles.includes(v.id) ? 'on' : ''}`} onClick={() => patch(r.id, { vehicles: toggleIn(r.vehicles, v.id) })}>{v.id}</button>
            ))}
          </div>

          <button className="btn" onClick={() => void save(r)}>שמור {r.id}</button>
        </div>
      ))}
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
