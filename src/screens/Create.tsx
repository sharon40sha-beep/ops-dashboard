import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { DEFAULT_TO_SITE, localToIso, siteKindHe } from '../lib/ops'
import type { DutyType, LinkableTrip } from '../types'
import Toast from '../components/Toast'

export default function Create() {
  const { session, token, logout } = useAuth()
  const { assets, sites, sitesById, routes, vehicles, employees, refresh } = useData()

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
  const [workerId, setWorkerId] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [route, setRoute] = useState('')
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
  const [dWorker, setDWorker] = useState('')
  const [dStart, setDStart] = useState('')
  const [dEnd, setDEnd] = useState('')

  const effectiveTo = toSite || (sitesById.has(DEFAULT_TO_SITE) ? DEFAULT_TO_SITE : '')

  useEffect(() => {
    if (!token) return
    void supabase.rpc('admin_list_linkable_trips', { session_token: token }).then(({ data }) => {
      setLinkable((data as LinkableTrip[]) ?? [])
    })
    void supabase.rpc('admin_list_duty_types', { session_token: token }).then(({ data }) => {
      setDutyTypes((data as DutyType[]) ?? [])
    })
  }, [token])

  async function submitDuty() {
    setErr('')
    if (!dSite || !dType || !dWorker) return setErr('יש לבחור אתר, סוג משמרת ועובד')
    if (!dStart || !dEnd) return setErr('יש למלא זמן התחלה וסיום')
    if (!token) return
    setSaving(true)
    const { error } = await supabase.rpc('create_duty_shift', {
      session_token: token,
      site_id: dSite,
      worker_id: dWorker,
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
    setDSite(''); setDType(''); setDWorker(''); setDStart(''); setDEnd('')
    setToast('נוצרה משמרת')
    void refresh()
  }

  function toggleAsset(id: string) {
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  async function submit() {
    setErr('')
    if (picked.size === 0) return setErr('יש לבחור לפחות מוצר אחד')
    if (!fromSite || !effectiveTo) return setErr('יש לבחור מאתר ולאתר')
    if (!workerId) return setErr('יש לבחור עובד מבצע')
    if (isReturn && !returnOf) return setErr('בחר/י את נסיעת ההלוך המקושרת')
    if (!session || !token) return

    setSaving(true)
    const { error } = await supabase.rpc('create_trip', {
      session_token: token,
      from_site_id: fromSite,
      to_site_id: effectiveTo,
      worker_id: workerId,
      vehicle_id: vehicle,
      route_id: route,
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
    setVehicle('')
    setRoute('')
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
            {sortedSites.map((s) => <option key={s.id} value={s.id}>{s.id} · {siteKindHe(s.kind)}</option>)}
          </select>
          <label>סוג משמרת</label>
          <select value={dType} onChange={(e) => setDType(e.target.value)}>
            <option value="">— בחר —</option>
            {dutyTypes.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <label>עובד</label>
          <select value={dWorker} onChange={(e) => setDWorker(e.target.value)}>
            <option value="">— בחר עובד —</option>
            {employees.map((w) => <option key={w.id} value={w.id}>{w.name}{w.role === 'admin' ? ' (מנהל)' : ''}</option>)}
          </select>
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
            <button
              key={a.id}
              className={`pick-chip ${picked.has(a.id) ? 'on' : ''}`}
              onClick={() => toggleAsset(a.id)}
              type="button"
            >
              {a.id}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>מאתר</label>
            <select value={fromSite} onChange={(e) => setFromSite(e.target.value)}>
              <option value="">— בחר —</option>
              {sortedSites.map((s) => <option key={s.id} value={s.id}>{s.id} · {siteKindHe(s.kind)}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>לאתר</label>
            <select value={effectiveTo} onChange={(e) => setToSite(e.target.value)}>
              {sortedSites.map((s) => <option key={s.id} value={s.id}>{s.id} · {siteKindHe(s.kind)}</option>)}
            </select>
          </div>
        </div>

        <label>עובד מבצע</label>
        <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
          <option value="">— בחר עובד —</option>
          {employees.map((w) => <option key={w.id} value={w.id}>{w.name}{w.role === 'admin' ? ' (מנהל)' : ''}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>רכב</label>
            <select value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
              <option value="">— בחר רכב —</option>
              {activeVehicles.map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>ציר</label>
            <select value={route} onChange={(e) => setRoute(e.target.value)}>
              <option value="">— בחר ציר —</option>
              {activeRoutes.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
            </select>
          </div>
        </div>

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
