import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { fmtDateTime, siteTypeLabel } from '../lib/ops'
import type { ChecklistItem, Trip, TripItem } from '../types'
import type { EditTarget } from '../App'
import Toast from '../components/Toast'
import DutyDetail from './DutyDetail'
import DeleteAction from '../components/DeleteAction'

interface DraftSegment { route_id: string; checkpoint_note: string }

function SiteLabel({ id }: { id: string }) {
  const { sitesById, siteTypesById } = useData()
  const t = siteTypeLabel(sitesById.get(id), siteTypesById)
  return (
    <span className="site">
      <span className="code">{id}</span>
      {t && <span className="kind-tag">{t}</span>}
    </span>
  )
}

/** "Blue → Green" from planned/actual route segments. */
function routesText(segs: { route_id: string | null }[]): string {
  const r = segs.map((s) => s.route_id).filter(Boolean)
  return r.length ? r.join(' → ') : '—'
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY'. */
function fmtDate(d: string): string {
  const p = d?.split('-')
  return p && p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d
}
const hm = (t: string | null) => (t ? t.slice(0, 5) : '')
/** planned window like "08:00–09:30" / "מ־08:00" / "עד 09:30", or '' if none. */
function plannedWindow(trip: Trip): string {
  const s = hm(trip.planned_start_time), e = hm(trip.planned_end_time)
  if (s && e) return `${s}–${e}`
  if (s) return `מ־${s}`
  if (e) return `עד ${e}`
  return ''
}

const STATUS_HE: Record<Trip['status'], string> = {
  planned: 'מתוכננת',
  active: 'פעילה',
  completed: 'הושלמה',
}

export default function Tasks({ onEdit, openTarget }: { onEdit: (t: EditTarget) => void; openTarget?: EditTarget | null }) {
  const { trips, duties, loading, refresh } = useData()
  const [open, setOpen] = useState<{ kind: 'trip' | 'duty'; id: string } | null>(openTarget ?? null)
  const [toast, setToast] = useState('')

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
          onBack={() => setOpen(null)}
          onEdit={onEdit}
          onSaved={(msg) => { void refresh(); if (msg) setToast(msg) }}
          onCompleted={() => { setOpen(null); void refresh(); setToast('הנסיעה הושלמה') }}
          onDeleted={() => { setOpen(null); void refresh(); setToast('נמחק') }}
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
          onEdit={onEdit}
          onSaved={(msg) => { void refresh(); if (msg) setToast(msg) }}
          onCompleted={() => { setOpen(null); void refresh(); setToast('המשמרת הושלמה') }}
          onDeleted={() => { setOpen(null); void refresh(); setToast('נמחק') }}
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
                {r.trip.label && <div className="task-label">{r.trip.label}</div>}
                <div className="route-line">
                  <SiteLabel id={r.trip.from_site_id} />
                  <span className="arrow">←</span>
                  <SiteLabel id={r.trip.to_site_id} />
                </div>
                <div className="task-card-meta">
                  <span>תאריך: {fmtDate(r.trip.scheduled_date)}</span>
                  <span>ציר: <strong>{routesText(r.trip.route_segments)}</strong></span>
                  {r.trip.vehicle_ids.length > 0 && <span>רכב: <span className="code sm">{r.trip.vehicle_ids.join(', ')}</span></span>}
                  {r.trip.workers.length > 0 && <span>עובדים: {r.trip.workers.map((w) => w.name).join(', ')}</span>}
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
                {r.duty.label && <div className="task-label">{r.duty.label}</div>}
                <div className="route-line"><span className="code">{r.duty.site_id}</span></div>
                <div className="task-card-meta">
                  <span>מ־{fmtDateTime(r.duty.start_time)}</span>
                  <span>עד {fmtDateTime(r.duty.end_time)}</span>
                  {r.duty.workers.length > 0 && <span>עובדים: {r.duty.workers.map((w) => w.name).join(', ')}</span>}
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
  onBack,
  onEdit,
  onSaved,
  onCompleted,
  onDeleted,
}: {
  trip: Trip
  onBack: () => void
  onEdit: (t: EditTarget) => void
  onDeleted: () => void
  onSaved: (msg?: string) => void
  onCompleted: () => void
}) {
  const { token, logout, session } = useAuth()
  const { routes, vehicles, entryPoints } = useData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const activeRoutes = useMemo(() => routes.filter((r) => r.is_active), [routes])
  const activeVehicles = useMemo(() => vehicles.filter((v) => v.is_active), [vehicles])
  const destEntryPoints = useMemo(
    () => entryPoints.filter((e) => e.is_active && e.site_id === trip.to_site_id),
    [entryPoints, trip.to_site_id],
  )

  // planned: per-item checklist + note (persisted individually)
  const [items, setItems] = useState<LocalItem[]>(
    trip.items.map((it: TripItem) => ({ id: it.id, asset_id: it.asset_id, checklist: it.checklist, note: it.checklist_note ?? '' })),
  )

  // active -> complete form. Defaults = the plan; the worker only edits what changed.
  const [showComplete, setShowComplete] = useState(false)
  const [aVehicles, setAVehicles] = useState<Set<string>>(new Set(trip.vehicle_ids))
  const [aSegments, setASegments] = useState<DraftSegment[]>(
    trip.route_segments.length > 0
      ? trip.route_segments.map((s) => ({ route_id: s.route_id ?? '', checkpoint_note: s.checkpoint_note ?? '' }))
      : [{ route_id: '', checkpoint_note: '' }],
  )
  const [aEntry, setAEntry] = useState(trip.planned_entry_point_id ?? '')
  const [reason, setReason] = useState('')

  const plannedRoutes = trip.route_segments.map((s) => s.route_id).filter(Boolean)
  const actualRoutes = aSegments.map((s) => s.route_id).filter((r) => r.trim() !== '')
  const routesDiff = JSON.stringify(plannedRoutes) !== JSON.stringify(actualRoutes)
  const vehDiff = JSON.stringify([...trip.vehicle_ids].sort()) !== JSON.stringify([...aVehicles].sort())
  const entryDiff = (trip.planned_entry_point_id ?? '') !== (aEntry ?? '')
  // worker flexibility: whoever completes is the actual performer; reason needed if not planned
  const workerDev = !!session && !trip.worker_ids.includes(session.employeeId)
  const deviated = routesDiff || vehDiff || entryDiff || workerDev

  const canStart = !busy && items.every((it) => !it.checklist.some((c) => !c.checked) || it.note.trim() !== '')

  function onRpcError(message: string) {
    if (message.includes('session')) { logout(); return }
    setErr(translateTripErr(message))
  }

  async function persistItem(it: LocalItem) {
    if (!token) return
    const { error } = await supabase.rpc('update_trip_item_checklist', {
      session_token: token, trip_item_id: it.id,
      p_checklist: it.checklist, p_note: it.note.trim() === '' ? null : it.note.trim(),
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

  function toggleVehicle(id: string) {
    setAVehicles((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function setSeg(i: number, patch: Partial<DraftSegment>) {
    setASegments((list) => list.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  }
  function addSeg() { setASegments((list) => [...list, { route_id: '', checkpoint_note: '' }]) }
  function removeSeg(i: number) { setASegments((list) => (list.length <= 1 ? list : list.filter((_, idx) => idx !== i))) }

  async function start() {
    if (!token) return
    setErr(''); setBusy(true)
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
    setErr(''); setBusy(true)
    const { error } = await supabase.rpc('complete_trip', {
      session_token: token,
      trip_id: trip.id,
      p_actual: {
        segments: aSegments.filter((s) => s.route_id.trim() !== '')
          .map((s) => ({ route_id: s.route_id, checkpoint_note: s.checkpoint_note.trim() || null })),
        vehicles: [...aVehicles],
        entry_point_id: aEntry || null,
        actual_worker_id: session?.employeeId ?? null,
        reason: reason.trim(),
      },
    })
    setBusy(false)
    if (error) return onRpcError(error.message)
    onCompleted()
  }

  return (
    <div>
      <div className="detail-topbar">
        <button className="btn secondary" onClick={onBack} style={{ marginTop: 0 }}>‹ חזרה לנסיעות</button>
        {session?.role === 'admin' && (
          <div style={{ display: 'flex', gap: 8 }}>
            {trip.status === 'planned' && (
              <button className="btn secondary" style={{ marginTop: 0 }} onClick={() => onEdit({ kind: 'trip', id: trip.id })}>ערוך</button>
            )}
            <DeleteAction label={`נסיעה ${trip.items.map((i) => i.asset_id).join(',')}`}
              run={(r, pin) => supabase.rpc('admin_delete_trip', { session_token: token, actor_pin: pin, trip_id: trip.id, reason: r })}
              onDone={onDeleted} />
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="task-card-top">
          <span className="trip-assets">
            {trip.items.map((it) => <span className="code" key={it.id}>{it.asset_id}</span>)}
          </span>
          <span className={`status-pill status-${trip.status}`}>{STATUS_HE[trip.status]}</span>
        </div>
        <div className="route-line big">
          <SiteLabel id={trip.from_site_id} />
          <span className="arrow">←</span>
          <SiteLabel id={trip.to_site_id} />
        </div>
        <div className="task-card-meta">
          <span>ציר מתוכנן: <strong>{routesText(trip.route_segments)}</strong></span>
          {trip.vehicle_ids.length > 0 && <span>רכב מתוכנן: <span className="code sm">{trip.vehicle_ids.join(', ')}</span></span>}
          {trip.entry_point && <span>שער יעד: {trip.entry_point}</span>}
          <span>תאריך: {fmtDate(trip.scheduled_date)}</span>
          {plannedWindow(trip) && <span>שעות מתוכננות: {plannedWindow(trip)}</span>}
          {trip.workers.length > 0 && <span>עובדים: {trip.workers.map((w) => w.name).join(', ')}</span>}
        </div>
        {trip.route_segments.some((s) => s.checkpoint_note) && (
          <div className="notes-box">
            {trip.route_segments.filter((s) => s.checkpoint_note).map((s, i) => (
              <div key={i}><strong>{s.route_id}</strong> — {s.checkpoint_note}</div>
            ))}
          </div>
        )}
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
                    <textarea rows={2} value={it.note} onChange={(e) => setNote(it.id, e.target.value)}
                      onBlur={() => void persistItem(items.find((x) => x.id === it.id)!)} placeholder="הסבר קצר לדילוג" />
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
              <h2 style={{ marginTop: 4 }}>השלמת נסיעה — בפועל</h2>
              <p className="muted">הערכים נטענו מהמתוכנן. שנה/י רק את מה שהיה שונה בפועל.</p>

              <label>רכבים בפועל</label>
              <div className="asset-pick">
                {activeVehicles.map((v) => (
                  <button key={v.id} type="button" className={`pick-chip ${aVehicles.has(v.id) ? 'on' : ''}`} onClick={() => toggleVehicle(v.id)}>
                    {v.id}
                  </button>
                ))}
              </div>

              <label>מסלול בפועל — קטעים לפי סדר</label>
              <div className="seg-list">
                {aSegments.map((s, i) => (
                  <div className="seg-row" key={i}>
                    <span className="seg-num">{i + 1}</span>
                    <select value={s.route_id} onChange={(e) => setSeg(i, { route_id: e.target.value })}>
                      <option value="">— ציר —</option>
                      {activeRoutes.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
                    </select>
                    <input type="text" value={s.checkpoint_note} placeholder="נקודת ציון (רשות)"
                      onChange={(e) => setSeg(i, { checkpoint_note: e.target.value })} />
                    {aSegments.length > 1 && <button type="button" className="btn sm ghost" onClick={() => removeSeg(i)}>✕</button>}
                  </div>
                ))}
              </div>
              <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} onClick={addSeg}>+ הוסף קטע</button>

              <label style={{ marginTop: 14 }}>שער כניסה בפועל</label>
              <select value={aEntry} onChange={(e) => setAEntry(e.target.value)} disabled={destEntryPoints.length === 0}>
                <option value="">{destEntryPoints.length === 0 ? '— אין שערים מוגדרים —' : '— ללא —'}</option>
                {destEntryPoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.label}</option>)}
              </select>

              {deviated && (
                <>
                  <label>סיבת סטייה *</label>
                  <input type="text" value={reason} placeholder="מדוע היה שונה מהמתוכנן?" onChange={(e) => setReason(e.target.value)} />
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
