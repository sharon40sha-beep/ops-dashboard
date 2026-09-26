import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { siteKindHe } from '../lib/ops'
import type { ChecklistItem, Site, Trip, TripItem } from '../types'
import Toast from '../components/Toast'

function SiteLabel({ id, sitesById }: { id: string; sitesById: Map<string, Site> }) {
  const kind = sitesById.get(id)?.kind
  return (
    <span className="site">
      <span className="code">{id}</span>
      {kind && <span className="kind-tag">{siteKindHe(kind)}</span>}
    </span>
  )
}

const STATUS_HE: Record<Trip['status'], string> = {
  planned: 'מתוכננת',
  active: 'פעילה',
  completed: 'הושלמה',
}

export default function Tasks() {
  const { trips, sitesById, employees, loading, refresh } = useData()
  const [openId, setOpenId] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    employees.forEach((e) => m.set(e.id, e.name))
    return m
  }, [employees])

  const open = openId ? trips.find((t) => t.id === openId) : null

  if (loading && trips.length === 0) return <div className="center-screen">טוען…</div>

  if (open && open.status !== 'completed') {
    return (
      <>
        <TripDetail
          trip={open}
          sitesById={sitesById}
          workerName={nameById.get(open.worker_id)}
          onBack={() => setOpenId(null)}
          onSaved={(msg) => {
            void refresh()
            if (msg) setToast(msg)
          }}
          onCompleted={() => {
            setOpenId(null)
            void refresh()
            setToast('הנסיעה הושלמה')
          }}
        />
        {toast && <Toast message={toast} onDone={() => setToast('')} />}
      </>
    )
  }

  return (
    <div>
      <div className="card">
        <h2>נסיעות פעילות ({trips.length})</h2>
        {trips.length === 0 && <p className="muted">אין נסיעות פעילות.</p>}
        <div className="chips" style={{ flexDirection: 'column' }}>
          {trips.map((t) => (
            <button key={t.id} className="task-card" onClick={() => setOpenId(t.id)}>
              <div className="task-card-top">
                <span className="trip-assets">
                  {t.items.map((it) => (
                    <span className="code" key={it.id}>{it.asset_id}</span>
                  ))}
                </span>
                <span className={`status-pill status-${t.status}`}>{STATUS_HE[t.status]}</span>
              </div>
              <div className="route-line">
                <SiteLabel id={t.from_site_id} sitesById={sitesById} />
                <span className="arrow">←</span>
                <SiteLabel id={t.to_site_id} sitesById={sitesById} />
              </div>
              <div className="task-card-meta">
                {t.route_id && <span>ציר: <strong>{t.route_id}</strong></span>}
                {t.vehicle_id && <span>רכב: <span className="code sm">{t.vehicle_id}</span></span>}
                {t.time_window && <span>חלון: {t.time_window}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

interface LocalItem { id: string; asset_id: string; checklist: ChecklistItem[]; note: string }

function TripDetail({
  trip,
  sitesById,
  workerName,
  onBack,
  onSaved,
  onCompleted,
}: {
  trip: Trip
  sitesById: Map<string, Site>
  workerName?: string
  onBack: () => void
  onSaved: (msg?: string) => void
  onCompleted: () => void
}) {
  const { token, logout } = useAuth()
  const { routes, vehicles } = useData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // planned: per-item checklist + note (persisted individually)
  const [items, setItems] = useState<LocalItem[]>(
    trip.items.map((it: TripItem) => ({ id: it.id, asset_id: it.asset_id, checklist: it.checklist, note: it.checklist_note ?? '' })),
  )

  // active: complete form
  const [showComplete, setShowComplete] = useState(false)
  const [vehicle, setVehicle] = useState(trip.vehicle_id ?? '')
  const [route, setRoute] = useState(trip.route_id ?? '')
  const [reason, setReason] = useState('')

  const deviated =
    vehicle.trim() !== (trip.vehicle_id ?? '').trim() || route.trim() !== (trip.route_id ?? '').trim()

  const canStart =
    !busy &&
    items.every((it) => !it.checklist.some((c) => !c.checked) || it.note.trim() !== '')

  function onRpcError(message: string) {
    if (message.includes('session')) {
      logout()
      return
    }
    setErr(translateTripErr(message))
  }

  async function persistItem(it: LocalItem) {
    if (!token) return
    const { error } = await supabase.rpc('update_trip_item_checklist', {
      session_token: token,
      trip_item_id: it.id,
      p_checklist: it.checklist,
      p_note: it.note.trim() === '' ? null : it.note.trim(),
    })
    if (error) onRpcError(error.message)
  }

  async function toggle(itemId: string, boxIdx: number) {
    let updated: LocalItem | undefined
    setItems((list) =>
      list.map((it) => {
        if (it.id !== itemId) return it
        updated = { ...it, checklist: it.checklist.map((c, i) => (i === boxIdx ? { ...c, checked: !c.checked } : c)) }
        return updated
      }),
    )
    if (updated) await persistItem(updated)
  }

  function setNote(itemId: string, val: string) {
    setItems((list) => list.map((it) => (it.id === itemId ? { ...it, note: val } : it)))
  }

  async function start() {
    if (!token) return
    setErr('')
    setBusy(true)
    const { error } = await supabase.rpc('start_trip', { session_token: token, trip_id: trip.id })
    setBusy(false)
    if (error) return onRpcError(error.message)
    onSaved('הנסיעה הופעלה')
  }

  async function complete() {
    if (!token) return
    if (deviated && reason.trim() === '') {
      setErr('זוהתה סטייה מהמתוכנן — חובה למלא סיבה לפני שמירה.')
      return
    }
    setErr('')
    setBusy(true)
    const { error } = await supabase.rpc('complete_trip', {
      session_token: token,
      trip_id: trip.id,
      p_actual: { vehicle: vehicle.trim(), route: route.trim(), reason: reason.trim() },
    })
    setBusy(false)
    if (error) return onRpcError(error.message)
    onCompleted()
  }

  return (
    <div>
      <button className="btn secondary" onClick={onBack} style={{ marginTop: 0 }}>
        ‹ חזרה לנסיעות
      </button>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="task-card-top">
          <span className="trip-assets">
            {trip.items.map((it) => <span className="code" key={it.id}>{it.asset_id}</span>)}
          </span>
          <span className={`status-pill status-${trip.status}`}>{STATUS_HE[trip.status]}</span>
        </div>
        <div className="route-line big">
          <SiteLabel id={trip.from_site_id} sitesById={sitesById} />
          <span className="arrow">←</span>
          <SiteLabel id={trip.to_site_id} sitesById={sitesById} />
        </div>
        <div className="task-card-meta">
          {trip.route_id && <span>ציר מתוכנן: <strong>{trip.route_id}</strong></span>}
          {trip.vehicle_id && <span>רכב מתוכנן: <span className="code sm">{trip.vehicle_id}</span></span>}
          {trip.time_window && <span>חלון זמן: {trip.time_window}</span>}
          {workerName && <span>עובד: {workerName}</span>}
        </div>
      </div>

      {trip.status === 'planned' && (
        <>
          {items.map((it) => {
            const hasUnchecked = it.checklist.some((c) => !c.checked)
            const ordered = it.checklist
              .map((c, i) => ({ c, i }))
              .sort((a, b) => Number(b.c.critical ?? false) - Number(a.c.critical ?? false))
            return (
              <div className="card" key={it.id}>
                <h2>מוצר <span className="code">{it.asset_id}</span> — צ׳קליסט</h2>
                <div className="checklist">
                  {ordered.map(({ c, i }) => (
                    <button key={i} className={`check-row ${c.checked ? 'checked' : ''}`} onClick={() => void toggle(it.id, i)} disabled={busy}>
                      <span className="check-box" />
                      <span className="check-label">{c.label}</span>
                      {c.critical && <span className="crit-badge">קריטי</span>}
                    </button>
                  ))}
                  {it.checklist.length === 0 && <p className="muted">אין סעיפים לתבנית של מוצר זה.</p>}
                </div>
                {hasUnchecked && (
                  <>
                    <label>יש סעיפים שלא סומנו — למה דילגת? (חובה)</label>
                    <textarea
                      rows={2}
                      value={it.note}
                      onChange={(e) => setNote(it.id, e.target.value)}
                      onBlur={() => void persistItem(items.find((x) => x.id === it.id)!)}
                      placeholder="הסבר קצר לדילוג"
                    />
                  </>
                )}
              </div>
            )
          })}

          <div className="card">
            {err && <div className="error-banner" style={{ marginBottom: 12 }}>{err}</div>}
            <button className="btn" onClick={() => void start()} disabled={!canStart}>
              {busy ? 'שומר…' : 'התחל נסיעה'}
            </button>
            {!canStart && <p className="muted" style={{ textAlign: 'center', marginTop: 8 }}>מלא/י הערת דילוג לכל מוצר עם סעיף לא-מסומן</p>}
          </div>
        </>
      )}

      {trip.status === 'active' && (
        <div className="card">
          {!showComplete ? (
            <button className="btn" onClick={() => setShowComplete(true)}>השלם נסיעה</button>
          ) : (
            <>
              <h2 style={{ marginTop: 4 }}>השלמת נסיעה — נתונים בפועל</h2>
              <label>רכב בפועל</label>
              <select value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
                <option value="">— בחר רכב —</option>
                {vehicles.filter((v) => v.is_active).map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
              </select>
              <label>ציר בפועל</label>
              <select value={route} onChange={(e) => setRoute(e.target.value)}>
                <option value="">— בחר ציר —</option>
                {routes.filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
              </select>
              {deviated && (
                <>
                  <label>סיבת סטייה *</label>
                  <input type="text" value={reason} placeholder="מדוע הרכב/ציר שונה מהמתוכנן?" onChange={(e) => setReason(e.target.value)} />
                  <p className="muted" style={{ color: 'var(--accent)', marginTop: 8 }}>זוהתה סטייה מהמתוכנן — חובה למלא סיבה.</p>
                </>
              )}
              {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn ghost" onClick={() => setShowComplete(false)} disabled={busy}>ביטול</button>
                <button className="btn" onClick={() => void complete()} disabled={busy}>{busy ? 'שומר…' : 'שמור והשלם'}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function translateTripErr(msg: string): string {
  if (msg.includes('skip note')) return 'יש למלא הערת דילוג לכל מוצר עם סעיף לא-מסומן'
  if (msg.includes('deviation reason')) return 'חובה למלא סיבת סטייה'
  if (msg.includes('not your trip')) return 'אין לך הרשאה לנסיעה זו'
  if (msg.includes('not active')) return 'הנסיעה אינה פעילה'
  if (msg.includes('not found')) return 'הנסיעה לא נמצאה'
  return msg
}
