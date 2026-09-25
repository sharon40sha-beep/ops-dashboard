import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { DEFAULT_TO_SITE, siteKindHe } from '../lib/ops'
import Toast from '../components/Toast'

export default function Create() {
  const { session, token, logout } = useAuth()
  const { assets, sites, sitesById, employees, refresh } = useData()

  const sortedAssets = useMemo(() => [...assets].sort((a, b) => (a.id < b.id ? -1 : 1)), [assets])
  const sortedSites = useMemo(() => [...sites].sort((a, b) => (a.id < b.id ? -1 : 1)), [sites])

  const [assetId, setAssetId] = useState('')
  const [fromSite, setFromSite] = useState('')
  const [toSite, setToSite] = useState('')
  const [workerId, setWorkerId] = useState('')
  const [vehicle, setVehicle] = useState('')
  const [route, setRoute] = useState('')
  const [timeWindow, setTimeWindow] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')

  // Effective asset defaults to the first one; "from" auto-fills from its home
  // warehouse unless the admin picked one manually.
  const activeAsset = assetId || sortedAssets[0]?.id || ''
  const homeSite = sortedAssets.find((a) => a.id === activeAsset)?.home_site_id ?? ''
  const effectiveFrom = fromSite || homeSite
  const effectiveTo = toSite || (sitesById.has(DEFAULT_TO_SITE) ? DEFAULT_TO_SITE : '')

  function onPickAsset(id: string) {
    setAssetId(id)
    // Reset "from" so it re-derives from the newly chosen asset's home warehouse.
    setFromSite('')
    setErr('')
  }

  async function submit() {
    setErr('')
    if (!activeAsset || !effectiveFrom || !effectiveTo) return setErr('יש לבחור מוצר, מאתר ולאתר')
    if (!workerId) return setErr('יש לבחור עובד מבצע')
    if (!session || !token) return

    setSaving(true)
    // tasks table is closed — create through the admin-only RPC (server sets the
    // default checklist + initial audit log).
    const { error } = await supabase.rpc('create_task', {
      session_token: token,
      asset_id: activeAsset,
      from_site_id: effectiveFrom,
      to_site_id: effectiveTo,
      worker_id: workerId,
      vehicle: vehicle.trim(),
      route: route.trim(),
      time_window: timeWindow.trim(),
    })
    setSaving(false)
    if (error) {
      if (error.message.includes('session')) return logout()
      setErr(error.message)
      return
    }
    // reset (keep the chosen asset for quick repeat)
    setWorkerId('')
    setVehicle('')
    setRoute('')
    setTimeWindow('')
    setToast(`נוצרה משימה למוצר ${activeAsset} (${effectiveFrom} ← ${effectiveTo})`)
    void refresh()
  }

  return (
    <div>
      <div className="card">
        <h2>יצירת משימה</h2>

        <label>מוצר</label>
        <select value={activeAsset} onChange={(e) => onPickAsset(e.target.value)}>
          {sortedAssets.length === 0 && <option value="">אין מוצרים — הרץ/י seed</option>}
          {sortedAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id} — מחסן-בית {a.home_site_id}
            </option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>מאתר</label>
            <select value={effectiveFrom} onChange={(e) => setFromSite(e.target.value)}>
              {sortedSites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · {siteKindHe(s.kind)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>לאתר</label>
            <select value={effectiveTo} onChange={(e) => setToSite(e.target.value)}>
              {sortedSites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · {siteKindHe(s.kind)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label>עובד מבצע</label>
        <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
          <option value="">— בחר עובד —</option>
          {employees.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.role === 'admin' ? ' (מנהל)' : ''}
            </option>
          ))}
        </select>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>קוד רכב</label>
            <input className="mono" type="text" value={vehicle} placeholder="לדוגמה V-12" onChange={(e) => setVehicle(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label>ציר</label>
            <input className="mono" type="text" value={route} placeholder="Blue / Green / Red" onChange={(e) => setRoute(e.target.value)} />
          </div>
        </div>

        <label>חלון זמן</label>
        <input type="text" value={timeWindow} placeholder="לדוגמה 08:00–09:30" onChange={(e) => setTimeWindow(e.target.value)} />

        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}

        <button className="btn" onClick={() => void submit()} disabled={saving}>
          {saving ? 'יוצר…' : 'צור משימה'}
        </button>
      </div>

      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
