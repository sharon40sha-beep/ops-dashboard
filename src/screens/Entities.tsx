import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import Toast from '../components/Toast'
import DeleteAction from '../components/DeleteAction'

type Section = 'assets' | 'sites' | 'sitetypes' | 'entrypoints' | 'routes' | 'vehicles'
interface AAsset { id: string; home_site_id: string; is_active: boolean; checklist_template_id: string | null }
interface ASite { id: string; site_type_id: string | null; is_active: boolean }
interface ACode { id: string; is_active: boolean }
interface ATemplate { id: string; name: string; is_active: boolean }
interface ASiteType { id: string; label: string; is_active: boolean }
interface AEntry { id: string; site_id: string; label: string; is_active: boolean }

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'assets', label: 'מוצרים' },
  { id: 'sites', label: 'אתרים' },
  { id: 'sitetypes', label: 'סוגי אתר' },
  { id: 'entrypoints', label: 'שערי כניסה' },
  { id: 'routes', label: 'צירים' },
  { id: 'vehicles', label: 'רכבים' },
]

export default function Entities() {
  const { token, logout } = useAuth()
  const { refreshReference } = useData()
  const [section, setSection] = useState<Section>('assets')
  const [assets, setAssets] = useState<AAsset[]>([])
  const [sites, setSites] = useState<ASite[]>([])
  const [siteTypes, setSiteTypes] = useState<ASiteType[]>([])
  const [entries, setEntries] = useState<AEntry[]>([])
  const [routes, setRoutes] = useState<ACode[]>([])
  const [vehicles, setVehicles] = useState<ACode[]>([])
  const [templates, setTemplates] = useState<ATemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')

  // add-form fields
  const [nId, setNId] = useState('')
  const [nHome, setNHome] = useState('')
  const [nType, setNType] = useState('')      // site's type (add site) / entry's site
  const [nLabel, setNLabel] = useState('')    // site-type / entry-point label
  const [nEntrySite, setNEntrySite] = useState('')
  const [nTpl, setNTpl] = useState('')

  const guard = (message: string): boolean => {
    if (message.includes('session')) { logout(); return true }
    setErr(message)
    return false
  }

  const load = useCallback(async () => {
    if (!token) return logout()
    setLoading(true)
    const [a, s, st, ep, r, v, tp] = await Promise.all([
      supabase.rpc('admin_list_assets', { session_token: token }),
      supabase.rpc('admin_list_sites', { session_token: token }),
      supabase.rpc('admin_list_site_types', { session_token: token }),
      supabase.rpc('admin_list_site_entry_points', { session_token: token }),
      supabase.rpc('admin_list_routes', { session_token: token }),
      supabase.rpc('admin_list_vehicles', { session_token: token }),
      supabase.rpc('admin_list_templates', { session_token: token }),
    ])
    setLoading(false)
    if (a.error) return logout()
    setAssets((a.data as AAsset[]) ?? [])
    setSites((s.data as ASite[]) ?? [])
    setSiteTypes((st.data as ASiteType[]) ?? [])
    setEntries((ep.data as AEntry[]) ?? [])
    setRoutes((r.data as ACode[]) ?? [])
    setVehicles((v.data as ACode[]) ?? [])
    setTemplates((tp.data as ATemplate[]) ?? [])
  }, [token, logout])

  useEffect(() => { void load() }, [load])

  async function after(error: { message: string } | null, okMsg: string) {
    if (error) { guard(error.message); return }
    setErr(''); setToast(okMsg)
    setNId(''); setNHome(''); setNType(''); setNLabel(''); setNEntrySite(''); setNTpl('')
    await load()
    void refreshReference() // pickers elsewhere reflect the change
  }

  const typeLabel = (id: string | null) => siteTypes.find((t) => t.id === id)?.label ?? '—'

  // ---- adds ----
  async function addRow() {
    if (!token) return
    setErr('')
    if (section === 'assets') {
      if (nId.trim() === '') return setErr('הזן קוד')
      if (!nHome) return setErr('בחר מחסן-בית')
      return after((await supabase.rpc('admin_add_asset', {
        session_token: token, id: nId.trim(), home_site_id: nHome, checklist_template_id: nTpl || null,
      })).error, 'נוסף')
    }
    if (section === 'sites') {
      if (nId.trim() === '') return setErr('הזן קוד')
      return after((await supabase.rpc('admin_add_site', {
        session_token: token, id: nId.trim(), site_type_id: nType || null,
      })).error, 'נוסף')
    }
    if (section === 'sitetypes') {
      if (nLabel.trim() === '') return setErr('הזן שם סוג')
      return after((await supabase.rpc('admin_add_site_type', { session_token: token, label: nLabel.trim() })).error, 'נוסף')
    }
    if (section === 'entrypoints') {
      if (!nEntrySite) return setErr('בחר אתר')
      if (nLabel.trim() === '') return setErr('הזן שם שער')
      return after((await supabase.rpc('admin_add_site_entry_point', {
        session_token: token, site_id: nEntrySite, label: nLabel.trim(),
      })).error, 'נוסף')
    }
    if (section === 'routes') {
      if (nId.trim() === '') return setErr('הזן קוד')
      return after((await supabase.rpc('admin_add_route', { session_token: token, id: nId.trim() })).error, 'נוסף')
    }
    if (nId.trim() === '') return setErr('הזן קוד')
    return after((await supabase.rpc('admin_add_vehicle', { session_token: token, id: nId.trim() })).error, 'נוסף')
  }

  // ---- updates ----
  async function saveAsset(a: AAsset) {
    if (!token) return
    return after((await supabase.rpc('admin_update_asset', {
      session_token: token, id: a.id, home_site_id: a.home_site_id, is_active: a.is_active,
      checklist_template_id: a.checklist_template_id,
    })).error, 'נשמר')
  }
  async function saveSite(s: ASite) {
    if (!token) return
    return after((await supabase.rpc('admin_update_site', {
      session_token: token, id: s.id, site_type_id: s.site_type_id, is_active: s.is_active,
    })).error, 'נשמר')
  }
  async function saveSiteType(t: ASiteType) {
    if (!token) return
    return after((await supabase.rpc('admin_update_site_type', {
      session_token: token, id: t.id, label: t.label.trim(), is_active: t.is_active,
    })).error, 'נשמר')
  }
  async function saveEntry(e: AEntry) {
    if (!token) return
    return after((await supabase.rpc('admin_update_site_entry_point', {
      session_token: token, id: e.id, label: e.label.trim(), is_active: e.is_active,
    })).error, 'נשמר')
  }
  async function toggleCode(kind: 'routes' | 'vehicles', c: ACode) {
    if (!token) return
    const fn = kind === 'routes' ? 'admin_update_route' : 'admin_update_vehicle'
    return after((await supabase.rpc(fn, { session_token: token, id: c.id, is_active: !c.is_active })).error, 'נשמר')
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="segmented" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        {SECTIONS.map((s) => (
          <button key={s.id} className={s.id === section ? 'active' : ''} onClick={() => { setSection(s.id); setErr('') }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Add form */}
      <div className="card">
        <h2>הוספה</h2>
        {(section === 'assets' || section === 'sites' || section === 'routes' || section === 'vehicles') && (
          <>
            <label>קוד</label>
            <input className="mono" type="text" value={nId} onChange={(e) => setNId(e.target.value)}
                   placeholder={section === 'assets' ? 'A7' : section === 'sites' ? 'S08' : section === 'routes' ? 'Blue2' : 'V4'} />
          </>
        )}
        {section === 'assets' && (
          <>
            <label>מחסן-בית</label>
            <select value={nHome} onChange={(e) => setNHome(e.target.value)}>
              <option value="">— בחר אתר —</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.id} · {typeLabel(s.site_type_id)}</option>)}
            </select>
            <label>תבנית צ׳קליסט</label>
            <select value={nTpl} onChange={(e) => setNTpl(e.target.value)}>
              <option value="">— ללא (צ׳קליסט ריק) —</option>
              {templates.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </>
        )}
        {section === 'sites' && (
          <>
            <label>סוג אתר</label>
            <select value={nType} onChange={(e) => setNType(e.target.value)}>
              <option value="">— ללא —</option>
              {siteTypes.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </>
        )}
        {section === 'sitetypes' && (
          <>
            <label>שם הסוג</label>
            <input type="text" value={nLabel} onChange={(e) => setNLabel(e.target.value)} placeholder="לדוגמה: מתקן ביניים" />
          </>
        )}
        {section === 'entrypoints' && (
          <>
            <label>אתר</label>
            <select value={nEntrySite} onChange={(e) => setNEntrySite(e.target.value)}>
              <option value="">— בחר אתר —</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.id} · {typeLabel(s.site_type_id)}</option>)}
            </select>
            <label>שם השער</label>
            <input type="text" value={nLabel} onChange={(e) => setNLabel(e.target.value)} placeholder="לדוגמה: כניסת אבנים" />
          </>
        )}
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
        <button className="btn" onClick={() => void addRow()}>הוסף</button>
      </div>

      {/* Assets */}
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
              <div className="emp-row-actions" style={{ flexWrap: 'wrap' }}>
                <select value={a.home_site_id}
                        onChange={(e) => setAssets((rs) => rs.map((x) => x.id === a.id ? { ...x, home_site_id: e.target.value } : x))}>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
                </select>
                <select value={a.checklist_template_id ?? ''}
                        onChange={(e) => setAssets((rs) => rs.map((x) => x.id === a.id ? { ...x, checklist_template_id: e.target.value || null } : x))}>
                  <option value="">— ללא תבנית —</option>
                  {templates.filter((t) => t.is_active || t.id === a.checklist_template_id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button className="btn sm" onClick={() => void saveAsset(a)}>שמור</button>
                <DeleteAction label={`מוצר ${a.id}`} small
                  run={(reason, pin) => supabase.rpc('admin_delete_asset', { session_token: token, actor_pin: pin, id: a.id, reason })}
                  onDone={() => { void load(); void refreshReference() }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sites */}
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
                <select value={s.site_type_id ?? ''}
                        onChange={(e) => setSites((rs) => rs.map((x) => x.id === s.id ? { ...x, site_type_id: e.target.value || null } : x))}>
                  <option value="">— ללא סוג —</option>
                  {siteTypes.filter((t) => t.is_active || t.id === s.site_type_id).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <button className="btn sm" onClick={() => void saveSite(s)}>שמור</button>
                <DeleteAction label={`אתר ${s.id}`} small
                  run={(reason, pin) => supabase.rpc('admin_delete_site', { session_token: token, actor_pin: pin, id: s.id, reason })}
                  onDone={() => { void load(); void refreshReference() }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Site types */}
      {section === 'sitetypes' && (
        <div className="card">
          <h2>סוגי אתר ({siteTypes.length})</h2>
          {siteTypes.map((t) => (
            <div className={`emp-row ${t.is_active ? '' : 'inactive'}`} key={t.id}>
              <input type="text" value={t.label} onChange={(e) => setSiteTypes((rs) => rs.map((x) => x.id === t.id ? { ...x, label: e.target.value } : x))} style={{ marginBottom: 8 }} />
              <div className="emp-row-actions">
                <button className="btn sm ghost" onClick={() => { const n = { ...t, is_active: !t.is_active }; setSiteTypes((rs) => rs.map((x) => x.id === t.id ? n : x)); void saveSiteType(n) }}>
                  {t.is_active ? 'לארכיון' : 'שחזר'}
                </button>
                <button className="btn sm" onClick={() => void saveSiteType(t)}>שמור</button>
                <DeleteAction label={`סוג אתר "${t.label}"`} small
                  run={(reason, pin) => supabase.rpc('admin_delete_site_type', { session_token: token, actor_pin: pin, id: t.id, reason })}
                  onDone={() => { void load(); void refreshReference() }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Entry points */}
      {section === 'entrypoints' && (
        <div className="card">
          <h2>שערי כניסה ({entries.length})</h2>
          {entries.map((e) => (
            <div className={`emp-row ${e.is_active ? '' : 'inactive'}`} key={e.id}>
              <div className="emp-row-head">
                <span className="code">{e.site_id}</span>
                <input type="text" value={e.label} onChange={(ev) => setEntries((rs) => rs.map((x) => x.id === e.id ? { ...x, label: ev.target.value } : x))} style={{ flex: 1 }} />
              </div>
              <div className="emp-row-actions">
                <button className="btn sm ghost" onClick={() => { const n = { ...e, is_active: !e.is_active }; setEntries((rs) => rs.map((x) => x.id === e.id ? n : x)); void saveEntry(n) }}>
                  {e.is_active ? 'לארכיון' : 'שחזר'}
                </button>
                <button className="btn sm" onClick={() => void saveEntry(e)}>שמור</button>
                <DeleteAction label={`שער "${e.label}"`} small
                  run={(reason, pin) => supabase.rpc('admin_delete_site_entry_point', { session_token: token, actor_pin: pin, id: e.id, reason })}
                  onDone={() => { void load(); void refreshReference() }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Routes */}
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
                <DeleteAction label={`ציר ${r.id}`} small
                  run={(reason, pin) => supabase.rpc('admin_delete_route', { session_token: token, actor_pin: pin, id: r.id, reason })}
                  onDone={() => { void load(); void refreshReference() }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Vehicles */}
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
                <DeleteAction label={`רכב ${v.id}`} small
                  run={(reason, pin) => supabase.rpc('admin_delete_vehicle', { session_token: token, actor_pin: pin, id: v.id, reason })}
                  onDone={() => { void load(); void refreshReference() }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}
