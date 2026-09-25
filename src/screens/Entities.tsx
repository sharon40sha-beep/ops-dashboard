import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { siteKindHe } from '../lib/ops'
import type { SiteKind } from '../types'
import Toast from '../components/Toast'

type Section = 'assets' | 'sites' | 'routes' | 'vehicles'
interface AAsset { id: string; home_site_id: string; is_active: boolean }
interface ASite { id: string; kind: SiteKind; is_active: boolean }
interface ACode { id: string; is_active: boolean }

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'assets', label: 'מוצרים' },
  { id: 'sites', label: 'אתרים' },
  { id: 'routes', label: 'צירים' },
  { id: 'vehicles', label: 'רכבים' },
]

export default function Entities() {
  const { token, logout } = useAuth()
  const { refreshReference } = useData()
  const [section, setSection] = useState<Section>('assets')
  const [assets, setAssets] = useState<AAsset[]>([])
  const [sites, setSites] = useState<ASite[]>([])
  const [routes, setRoutes] = useState<ACode[]>([])
  const [vehicles, setVehicles] = useState<ACode[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')

  // add-form fields
  const [nId, setNId] = useState('')
  const [nHome, setNHome] = useState('')
  const [nKind, setNKind] = useState<SiteKind>('warehouse')

  const guard = (message: string): boolean => {
    if (message.includes('session')) {
      logout()
      return true
    }
    setErr(message)
    return false
  }

  const load = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const [a, s, r, v] = await Promise.all([
      supabase.rpc('admin_list_assets', { session_token: token }),
      supabase.rpc('admin_list_sites', { session_token: token }),
      supabase.rpc('admin_list_routes', { session_token: token }),
      supabase.rpc('admin_list_vehicles', { session_token: token }),
    ])
    setLoading(false)
    if (a.error) return logout()
    setAssets((a.data as AAsset[]) ?? [])
    setSites((s.data as ASite[]) ?? [])
    setRoutes((r.data as ACode[]) ?? [])
    setVehicles((v.data as ACode[]) ?? [])
  }, [token, logout])

  useEffect(() => {
    void load()
  }, [load])

  async function after(error: { message: string } | null, okMsg: string) {
    if (error) {
      guard(error.message)
      return
    }
    setErr('')
    setToast(okMsg)
    setNId('')
    setNHome('')
    setNKind('warehouse')
    await load()
    void refreshReference() // pickers in create/log reflect the change
  }

  // ---- adds ----
  async function addRow() {
    if (!token || nId.trim() === '') return
    setErr('')
    if (section === 'assets') {
      if (!nHome) return setErr('בחר מחסן-בית')
      const { error } = await supabase.rpc('admin_add_asset', { session_token: token, id: nId.trim(), home_site_id: nHome })
      return after(error, 'נוסף')
    }
    if (section === 'sites') {
      const { error } = await supabase.rpc('admin_add_site', { session_token: token, id: nId.trim(), kind: nKind })
      return after(error, 'נוסף')
    }
    if (section === 'routes') {
      const { error } = await supabase.rpc('admin_add_route', { session_token: token, id: nId.trim() })
      return after(error, 'נוסף')
    }
    const { error } = await supabase.rpc('admin_add_vehicle', { session_token: token, id: nId.trim() })
    return after(error, 'נוסף')
  }

  // ---- updates ----
  async function saveAsset(a: AAsset) {
    if (!token) return
    const { error } = await supabase.rpc('admin_update_asset', {
      session_token: token, id: a.id, home_site_id: a.home_site_id, is_active: a.is_active,
    })
    return after(error, 'נשמר')
  }
  async function saveSite(s: ASite) {
    if (!token) return
    const { error } = await supabase.rpc('admin_update_site', {
      session_token: token, id: s.id, kind: s.kind, is_active: s.is_active,
    })
    return after(error, 'נשמר')
  }
  async function toggleCode(kind: 'routes' | 'vehicles', c: ACode) {
    if (!token) return
    const fn = kind === 'routes' ? 'admin_update_route' : 'admin_update_vehicle'
    const { error } = await supabase.rpc(fn, { session_token: token, id: c.id, is_active: !c.is_active })
    return after(error, 'נשמר')
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="segmented" style={{ marginBottom: 14 }}>
        {SECTIONS.map((s) => (
          <button key={s.id} className={s.id === section ? 'active' : ''} onClick={() => { setSection(s.id); setErr('') }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Add form */}
      <div className="card">
        <h2>הוספה</h2>
        <label>קוד</label>
        <input className="mono" type="text" value={nId} onChange={(e) => setNId(e.target.value)}
               placeholder={section === 'assets' ? 'A7' : section === 'sites' ? 'S08' : section === 'routes' ? 'Blue2' : 'V4'} />
        {section === 'assets' && (
          <>
            <label>מחסן-בית</label>
            <select value={nHome} onChange={(e) => setNHome(e.target.value)}>
              <option value="">— בחר אתר —</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.id} · {siteKindHe(s.kind)}</option>)}
            </select>
          </>
        )}
        {section === 'sites' && (
          <>
            <label>סוג</label>
            <select value={nKind} onChange={(e) => setNKind(e.target.value as SiteKind)}>
              <option value="warehouse">מחסן</option>
              <option value="factory">מפעל</option>
              <option value="other">מתקן</option>
            </select>
          </>
        )}
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn" onClick={() => void addRow()} disabled={nId.trim() === ''}>הוסף</button>
      </div>

      {/* Lists */}
      {section === 'assets' && (
        <div className="card">
          <h2>מוצרים ({assets.length})</h2>
          {assets.map((a) => (
            <div className={`emp-row ${a.is_active ? '' : 'inactive'}`} key={a.id}>
              <div className="emp-row-head">
                <span className="code">{a.id}</span>
                <label className="inline-check">
                  <input type="checkbox" checked={a.is_active}
                         onChange={(e) => setAssets((rs) => rs.map((x) => x.id === a.id ? { ...x, is_active: e.target.checked } : x))} />
                  <span>פעיל</span>
                </label>
              </div>
              <div className="emp-row-actions">
                <select value={a.home_site_id}
                        onChange={(e) => setAssets((rs) => rs.map((x) => x.id === a.id ? { ...x, home_site_id: e.target.value } : x))}>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
                </select>
                <button className="btn sm" onClick={() => void saveAsset(a)}>שמור</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {section === 'sites' && (
        <div className="card">
          <h2>אתרים ({sites.length})</h2>
          {sites.map((s) => (
            <div className={`emp-row ${s.is_active ? '' : 'inactive'}`} key={s.id}>
              <div className="emp-row-head">
                <span className="code">{s.id}</span>
                <label className="inline-check">
                  <input type="checkbox" checked={s.is_active}
                         onChange={(e) => setSites((rs) => rs.map((x) => x.id === s.id ? { ...x, is_active: e.target.checked } : x))} />
                  <span>פעיל</span>
                </label>
              </div>
              <div className="emp-row-actions">
                <select value={s.kind}
                        onChange={(e) => setSites((rs) => rs.map((x) => x.id === s.id ? { ...x, kind: e.target.value as SiteKind } : x))}>
                  <option value="warehouse">מחסן</option>
                  <option value="factory">מפעל</option>
                  <option value="other">מתקן</option>
                </select>
                <button className="btn sm" onClick={() => void saveSite(s)}>שמור</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {section === 'routes' && (
        <div className="card">
          <h2>צירים ({routes.length})</h2>
          {routes.map((r) => (
            <div className={`emp-row ${r.is_active ? '' : 'inactive'}`} key={r.id}>
              <div className="emp-row-head">
                <span className="code">{r.id}</span>
                <button className={`btn sm ${r.is_active ? 'ghost' : ''}`} onClick={() => void toggleCode('routes', r)}>
                  {r.is_active ? 'השבת' : 'הפעל'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {section === 'vehicles' && (
        <div className="card">
          <h2>רכבים ({vehicles.length})</h2>
          {vehicles.map((v) => (
            <div className={`emp-row ${v.is_active ? '' : 'inactive'}`} key={v.id}>
              <div className="emp-row-head">
                <span className="code">{v.id}</span>
                <button className={`btn sm ${v.is_active ? 'ghost' : ''}`} onClick={() => void toggleCode('vehicles', v)}>
                  {v.is_active ? 'השבת' : 'הפעל'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
