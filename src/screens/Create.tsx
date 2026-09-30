import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { DEFAULT_TO_SITE, localToIso, siteLabel } from '../lib/ops'
import type { DutyType, LinkableTrip } from '../types'
import Toast from '../components/Toast'

interface DraftSegment { route_id: string; checkpoint_note: string }

export default function Create() {
  const { session, token, logout } = useAuth()
  const { assets, sites, sitesById, siteTypesById, routes, vehicles, entryPoints, employees, refresh } = useData()

  const activeAssets = useMemo(
    () => assets.filter((a) => a.is_active !== false).sort((a, b) => (a.id < b.id ? -1 : 1)),
    [assets],
  )
  const sortedSites = useMemo(
    () => sites.filter((s) => s.is_active !== false).sort((a, b) => (a.id < b.id ? -1 : 1)),
    [sites],
  )
  const activeRoutes = useMemo(() => routes.filter((r) => r.is_active), [routes])
  const activeVehicles = useMemo(() => vehicles.filter((v) => v.is_active), [vehicles])

  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [fromSite, setFromSite] = useState('')
  const [toSite, setToSite] = useState('')
  const [workers, setWorkers] = useState<Set<string>>(new Set())
  const [vehiclesPicked, setVehiclesPicked] = useState<Set<string>>(new Set())
  const [segments, setSegments] = useState<DraftSegment[]>([{ route_id: '', checkpoint_note: '' }])
  const [entryPointId, setEntryPointId] = useState('')
  const [timeWindow, setTimeWindow] = useState('')
  const [isReturn, setIsReturn] = useState(false)
  const [returnOf, setReturnOf] = useState('')
  const [linkable, setLinkable] = useState<LinkableTrip[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')

  // trip vs shift
  const [mode, setMode] = useState<'trip' | 'duty'>('trip')
  const [dutyTypes, setDutyTypes] = useState<DutyType[]>([])
  const [dSite, setDSite] = useState('')
  const [dType, setDType] = useState('')
  const [dWorkers, setDWorkers] = useState<Set<string>>(new Set())
  const [dStart, setDStart] = useState('')
  const [dEnd, setDEnd] = useState('')

  const effectiveTo = toSite || (sitesById.has(DEFAULT_TO_SITE) ? DEFAULT_TO_SITE : '')
  const destEntryPoints = useMemo(
    () => entryPoints.filter((e) => e.is_active && e.site_id === effectiveTo),
    [entryPoints, effectiveTo],
  )

  useEffect(() => {
    if (!token) return
    void supabase.rpc('admin_list_linkable_trips', { session_token: token }).then(({ data }) => {
      setLinkable((data as LinkableTrip[]) ?? [])
    })
    void supabase.rpc('admin_list_duty_types', { session_token: token }).then(({ data }) => {
      setDutyTypes((data as DutyType[]) ?? [])
    })
  }, [token])

  // the chosen entry point must belong to the current destination
  useEffect(() => {
    if (entryPointId && !destEntryPoints.some((e) => e.id === entryPointId)) setEntryPointId('')
  }, [destEntryPoints, entryPointId])

  function toggle(set: Set<string>, setter: (s: Set<string>) => void, id: string) {
    const n = new Set(set)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setter(n)
  }

  // ---- route-segment editing ----
  function setSeg(i: number, patch: Partial<DraftSegment>) {
    setSegments((list) => list.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }
  function addSeg() {
    setSegments((list) => [...list, { route_id: '', checkpoint_note: '' }])
  }
  function removeSeg(i: number) {
    setSegments((list) => (list.length <= 1 ? list : list.filter((_, idx) => idx !== i)))
  }

  async function submitDuty() {
    setErr('')
    if (!dSite || !dType) return setErr('יש לבחור אתר וסוג משמרת')
    if (dWorkers.size === 0) return setErr('יש לבחור לפחות עובד אחד')
    if (!dStart || !dEnd) return setErr('יש למלא זמן התחלה וסיום')
    if (!token) return
    setSaving(true)
    const { error } = await supabase.rpc('create_duty_shift', {
      session_token: token,
      site_id: dSite,
      worker_ids: [...dWorkers],
      duty_type_id: dType,
      start_time: localToIso(dStart),
      end_time: localToIso(dEnd),
    })
    setSaving(false)
    if (error) {
      if (error.message.includes('session')) return logout()
      setErr(error.message)
      return
    }
    setDSite(''); setDType(''); setDWorkers(new Set()); setDStart(''); setDEnd('')
    setToast('נוצרה משמרת')
    void refresh()
  }

  async function submit() {
    setErr('')
    if (picked.size === 0) return setErr('יש לבחור לפחות מוצר אחד')
    if (!fromSite || !effectiveTo) return setErr('יש לבחור מאתר ולאתר')
    if (workers.size === 0) return setErr('יש לבחור לפחות עובד מבצע אחד')
    if (isReturn && !returnOf) return setErr('בחר/י את נסיעת ההלוך המקושרת')
    if (!session || !token) return

    const cleanSegments = segments
      .filter((s) => s.route_id.trim() !== '')
      .map((s, i) => ({ sequence: i + 1, route_id: s.route_id, checkpoint_note: s.checkpoint_note.trim() || null }))

    setSaving(true)
    const { error } = await supabase.rpc('create_trip', {
      session_token: token,
      from_site_id: fromSite,
      to_site_id: effectiveTo,
      worker_ids: [...workers],
      vehicle_ids: [...vehiclesPicked],
      route_segments: cleanSegments,
      entry_point_id: entryPointId || null,
      time_window: timeWindow.trim(),
      asset_ids: [...picked],
      return_of_trip_id: isReturn ? returnOf : null,
    })
    setSaving(false)
    if (error) {
      if (error.message.includes('session')) return logout()
      setErr(error.message)
      return
    }
    setPicked(new Set())
    setWorkers(new Set())
    setVehiclesPicked(new Set())
    setSegments([{ route_id: '', checkpoint_note: '' }])
    setEntryPointId('')
    setTimeWindow('')
    setIsReturn(false)
    setReturnOf('')
    setToast(`נוצרה נסיעה (${fromSite} ← ${effectiveTo})`)
    void refresh()
  }

  return (
    <div>
      <div className="segmented" style={{ marginBottom: 14 }}>
        <button className={mode === 'trip' ? 'active' : ''} onClick={() => { setMode('trip'); setErr('') }}>🚚 נסיעה</button>
        <button className={mode === 'duty' ? 'active' : ''} onClick={() => { setMode('duty'); setErr('') }}>🛡️ משמרת</button>
      </div>

      {mode === 'duty' && (
        <div className="card">
          <h2>יצירת משמרת</h2>
          <label>אתר</label>
          <select value={dSite} onChange={(e) => setDSite(e.target.value)}>
            <option value="">— בחר —</option>
            {sortedSites.map((s) => <option key={s.id} value={s.id}>{siteLabel(s, s.id, siteTypesById)}</option>)}
          </select>
          <label>סוג משמרת</label>
          <select value={dType} onChange={(e) => setDType(e.target.value)}>
            <option value="">— בחר —</option>
            {dutyTypes.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <label>עובדים (אחד או יותר)</label>
          <div className="asset-pick">
            {employees.map((w) => (
              <button key={w.id} type="button" className={`pick-chip ${dWorkers.has(w.id) ? 'on' : ''}`}
                onClick={() => toggle(dWorkers, setDWorkers, w.id)}>
                {w.name}{w.role === 'admin' ? ' (מנהל)' : ''}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label>התחלה</label>
              <input type="datetime-local" value={dStart} onChange={(e) => setDStart(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label>סיום</label>
              <input type="datetime-local" value={dEnd} onChange={(e) => setDEnd(e.target.value)} />
            </div>
          </div>
          {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
          <button className="btn" onClick={() => void submitDuty()} disabled={saving}>{saving ? 'יוצר…' : 'צור משמרת'}</button>
        </div>
      )}

      {mode === 'trip' && (
      <div className="card">
        <h2>יצירת נסיעה</h2>

        <label>מוצרים בנסיעה (הגרלה משותפת אחת)</label>
        <div className="asset-pick">
          {activeAssets.length === 0 && <p className="muted">אין מוצרים פעילים</p>}
          {activeAssets.map((a) => (
            <button key={a.id} type="button" className={`pick-chip ${picked.has(a.id) ? 'on' : ''}`}
              onClick={() => toggle(picked, setPicked, a.id)}>
              {a.id}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>מאתר</label>
            <select value={fromSite} onChange={(e) => setFromSite(e.target.value)}>
              <option value="">— בחר —</option>
              {sortedSites.map((s) => <option key={s.id} value={s.id}>{siteLabel(s, s.id, siteTypesById)}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>לאתר</label>
            <select value={effectiveTo} onChange={(e) => setToSite(e.target.value)}>
              {sortedSites.map((s) => <option key={s.id} value={s.id}>{siteLabel(s, s.id, siteTypesById)}</option>)}
            </select>
          </div>
        </div>

        <label>עובדים מבצעים (אחד או יותר)</label>
        <div className="asset-pick">
          {employees.map((w) => (
            <button key={w.id} type="button" className={`pick-chip ${workers.has(w.id) ? 'on' : ''}`}
              onClick={() => toggle(workers, setWorkers, w.id)}>
              {w.name}{w.role === 'admin' ? ' (מנהל)' : ''}
            </button>
          ))}
        </div>

        <label>רכבים (אחד או יותר)</label>
        <div className="asset-pick">
          {activeVehicles.length === 0 && <p className="muted">אין רכבים פעילים</p>}
          {activeVehicles.map((v) => (
            <button key={v.id} type="button" className={`pick-chip ${vehiclesPicked.has(v.id) ? 'on' : ''}`}
              onClick={() => toggle(vehiclesPicked, setVehiclesPicked, v.id)}>
              {v.id}
            </button>
          ))}
        </div>

        <label>מסלול — קטעים לפי סדר</label>
        <div className="seg-list">
          {segments.map((s, i) => (
            <div className="seg-row" key={i}>
              <span className="seg-num">{i + 1}</span>
              <select value={s.route_id} onChange={(e) => setSeg(i, { route_id: e.target.value })}>
                <option value="">— ציר —</option>
                {activeRoutes.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
              </select>
              <input type="text" value={s.checkpoint_note} placeholder="נקודת ציון / פנייה (רשות)"
                onChange={(e) => setSeg(i, { checkpoint_note: e.target.value })} />
              {segments.length > 1 && (
                <button type="button" className="btn sm ghost" onClick={() => removeSeg(i)}>✕</button>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} onClick={addSeg}>+ הוסף קטע</button>

        <label style={{ marginTop: 14 }}>שער כניסה ביעד</label>
        <select value={entryPointId} onChange={(e) => setEntryPointId(e.target.value)} disabled={destEntryPoints.length === 0}>
          <option value="">{destEntryPoints.length === 0 ? '— אין שערים מוגדרים ליעד —' : '— ללא —'}</option>
          {destEntryPoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.label}</option>)}
        </select>

        <label>חלון זמן</label>
        <input type="text" value={timeWindow} placeholder="לדוגמה 08:00–09:30" onChange={(e) => setTimeWindow(e.target.value)} />

        <label className="inline-check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={isReturn} onChange={(e) => setIsReturn(e.target.checked)} />
          <span>זו נסיעת חזרה של נסיעה קיימת</span>
        </label>
        {isReturn && (
          <select value={returnOf} onChange={(e) => setReturnOf(e.target.value)}>
            <option value="">— בחר נסיעת הלוך —</option>
            {linkable.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        )}

        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}

        <button className="btn" onClick={() => void submit()} disabled={saving}>
          {saving ? 'יוצר…' : 'צור נסיעה'}
        </button>
      </div>
      )}

      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
