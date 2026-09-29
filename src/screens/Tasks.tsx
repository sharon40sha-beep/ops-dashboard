import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { fmtDateTime, siteKindHe } from '../lib/ops'
import type { ChecklistItem, Site, Trip, TripItem } from '../types'
import Toast from '../components/Toast'
import DutyDetail from './DutyDetail'

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
  const { trips, duties, sitesById, employees, loading, refresh } = useData()
  const [open, setOpen] = useState<{ kind: 'trip' | 'duty'; id: string } | null>(null)
  const [toast, setToast] = useState('')

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    employees.forEach((e) => m.set(e.id, e.name))
    return m
  }, [employees])

  // trips + duty shifts merged into one time-sorted feed
  const rows = useMemo(() => {
    const t = trips.map((x) => ({ kind: 'trip' as const, id: x.id, created_at: x.created_at, trip: x }))
    const d = duties.map((x) => ({ kind: 'duty' as const, id: x.id, created_at: x.created_at, duty: x }))
    return [...t, ...d].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }, [trips, duties])

  const openTrip = open?.kind === 'trip' ? trips.find((t) => t.id === open.id) : null
  const openDuty = open?.kind === 'duty' ? duties.find((d) => d.id === open.id) : null

  if (loading && rows.length === 0) return <div className="center-screen">טוען…</div>

  if (openTrip && openTrip.status !== 'completed') {
    return (
      <>
        <TripDetail
          trip={openTrip}
          sitesById={sitesById}
          workerName={nameById.get(openTrip.worker_id)}
          onBack={() => setOpen(null)}
          onSaved={(msg) => { void refresh(); if (msg) setToast(msg) }}
          onCompleted={() => { setOpen(null); void refresh(); setToast('הנסיעה הושלמה') }}
        />
        {toast && <Toast message={toast} onDone={() => setToast('')} />}
      </>
    )
  }

  if (openDuty && openDuty.status !== 'completed') {
    return (
      <>
        <DutyDetail
          duty={openDuty}
          onBack={() => setOpen(null)}
          onSaved={(msg) => { void refresh(); if (msg) setToast(msg) }}
          onCompleted={() => { setOpen(null); void refresh(); setToast('המשמרת הושלמה') }}
        />
        {toast && <Toast message={toast} onDone={() => setToast('')} />}
      </>
    )
  }

  return (
    <div>
      <div className="card">
        <h2>משימות פעילות ({rows.length})</h2>
        {rows.length === 0 && <p className="muted">אין משימות פעילות.</p>}
        <div className="chips" style={{ flexDirection: 'column' }}>
          {rows.map((r) =>
            r.kind === 'trip' ? (
              <button key={`t-${r.id}`} className="task-card" onClick={() => setOpen({ kind: 'trip', id: r.id })}>
                <div className="task-card-top">
                  <span className="trip-assets">
                    <span className="kind-dot trip">🚚</span>
                    {r.trip.items.map((it) => <span className="code" key={it.id}>{it.asset_id}</span>)}
                  </span>
                  <span className={`status-pill status-${r.trip.status}`}>{STATUS_HE[r.trip.status]}</span>
                </div>
                <div className="route-line">
                  <SiteLabel id={r.trip.from_site_id} sitesById={sitesById} />
                  <span className="arrow">←</span>
                  <SiteLabel id={r.trip.to_site_id} sitesById={sitesById} />
                </div>
                <div className="task-card-meta">
                  {r.trip.route_id && <span>ציר: <strong>{r.trip.route_id}</strong></span>}
                  {r.trip.vehicle_id && <span>רכב: <span className="code sm">{r.trip.vehicle_id}</span></span>}
                  {r.trip.time_window && <span>חלון: {r.trip.time_window}</span>}
                </div>
              </button>
            ) : (
              <button key={`d-${r.id}`} className="task-card" onClick={() => setOpen({ kind: 'duty', id: r.id })}>
                <div className="task-card-top">
                  <span className="trip-assets">
                    <span className="kind-dot duty">🛡️</span>
                    <strong>{r.duty.duty_type_label}</strong>
                  </span>
                  <span className={`status-pill status-${r.duty.status}`}>{STATUS_HE[r.duty.status]}</span>
                </div>
                <div className="route-line"><span className="code">{r.duty.site_id}</span></div>
                <div className="task-card-meta">
                  <span>מ־{fmtDateTime(r.duty.start_time)}</span>
                  <span>עד {fmtDateTime(r.duty.end_time)}</span>
                </div>
              </button>
            ),
          )}
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
