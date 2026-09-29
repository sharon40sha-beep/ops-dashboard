import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { fmtDateTime, siteKindHe } from '../lib/ops'
import DeleteAction from '../components/DeleteAction'
import type { DutyShift, Trip } from '../types'

export default function History() {
  const { session, token, logout } = useAuth()
  const { history, trips, dutyHistory, sitesById, employees, refresh } = useData()
  const isAdmin = session?.role === 'admin'
  const [openLog, setOpenLog] = useState<string | null>(null)

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    employees.forEach((e) => m.set(e.id, e.name))
    return m
  }, [employees])

  const allTrips = useMemo(() => [...history, ...trips], [history, trips])
  const labelById = useMemo(() => {
    const m = new Map<string, string>()
    allTrips.forEach((t) => m.set(t.id, `${t.items.map((i) => i.asset_id).join(',')} · ${t.from_site_id}←${t.to_site_id}`))
    return m
  }, [allTrips])
  const returnByOutbound = useMemo(() => {
    const m = new Map<string, Trip>()
    allTrips.forEach((t) => { if (t.return_of_trip_id) m.set(t.return_of_trip_id, t) })
    return m
  }, [allTrips])

  const rows = useMemo(() => {
    const t = history.map((x) => ({ kind: 'trip' as const, id: x.id, created_at: x.created_at, trip: x }))
    const d = dutyHistory.map((x) => ({ kind: 'duty' as const, id: x.id, created_at: x.created_at, duty: x }))
    return [...t, ...d].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }, [history, dutyHistory])

  function siteText(id: string): string {
    const kind = sitesById.get(id)?.kind
    return kind ? `${id} · ${siteKindHe(kind)}` : id
  }

  async function setTripExcl(id: string, excluded: boolean, reason: string) {
    if (!token) return
    const { error } = await supabase.rpc('admin_set_trip_analysis_exclusion', { session_token: token, trip_id: id, excluded, reason })
    if (error) { if (error.message.includes('session')) logout(); return }
    void refresh()
  }
  async function setDutyExcl(id: string, excluded: boolean, reason: string) {
    if (!token) return
    const { error } = await supabase.rpc('admin_set_duty_analysis_exclusion', { session_token: token, duty_shift_id: id, excluded, reason })
    if (error) { if (error.message.includes('session')) logout(); return }
    void refresh()
  }

  return (
    <div>
      <div className="card">
        <h2>היסטוריה ({rows.length})</h2>
        {rows.length === 0 && <p className="muted">אין רשומות שהושלמו.</p>}
      </div>
      {rows.map((r) => (r.kind === 'trip' ? renderTrip(r.trip) : renderDuty(r.duty)))}
    </div>
  )

  function renderTrip(t: Trip) {
    const a = t.actual
    const vDiff = a ? (a.vehicle ?? '').trim() !== (t.vehicle_id ?? '').trim() : false
    const rDiff = a ? (a.route ?? '').trim() !== (t.route_id ?? '').trim() : false
    const logOpen = openLog === t.id
    const ret = returnByOutbound.get(t.id)
    return (
      <div className="card" key={`t-${t.id}`}>
        <div className="task-card-top">
          <span className="trip-assets">
            <span className="kind-dot trip">🚚</span>
            {t.items.map((it) => <span className="code" key={it.id}>{it.asset_id}</span>)}
          </span>
          <span className="muted">{a?.completed_at ? fmtDateTime(a.completed_at) : ''}</span>
        </div>
        <div className="route-line" style={{ margin: '10px 0' }}>
          <span className="code">{siteText(t.from_site_id)}</span>
          <span className="arrow">←</span>
          <span className="code">{siteText(t.to_site_id)}</span>
        </div>
        <div className="pa-grid">
          <div className="pa-head">מתוכנן</div>
          <div className="pa-head">בפועל</div>
          <div className="pa-cell">רכב: <span className="code sm">{t.vehicle_id || '—'}</span></div>
          <div className={`pa-cell ${vDiff ? 'diff' : ''}`}>רכב: <span className="code sm">{a?.vehicle || '—'}</span></div>
          <div className="pa-cell">ציר: <strong>{t.route_id || '—'}</strong></div>
          <div className={`pa-cell ${rDiff ? 'diff' : ''}`}>ציר: <strong>{a?.route || '—'}</strong></div>
        </div>
        {a?.deviated && <div className="reason-box"><strong>סיבת סטייה:</strong> {a.reason || '—'}</div>}
        {t.return_of_trip_id && <div className="link-box">↔ חזרה של: {labelById.get(t.return_of_trip_id) ?? 'נסיעה'}</div>}
        {ret && <div className="link-box">↔ נסיעת חזרה: {labelById.get(ret.id) ?? 'נסיעה'}</div>}
        {t.items.some((it) => it.checklist_note) && (
          <div className="notes-box">
            {t.items.filter((it) => it.checklist_note).map((it) => (
              <div key={it.id}><span className="code sm">{it.asset_id}</span> — דילוג: {it.checklist_note}</div>
            ))}
          </div>
        )}

        {isAdmin && (
          <div className="admin-row">
            <AnalysisToggle excluded={!!t.excluded_from_analysis} reason={t.excluded_reason ?? null}
              onSet={(ex, rs) => setTripExcl(t.id, ex, rs)} />
            <DeleteAction label={`נסיעה ${t.items.map((i) => i.asset_id).join(',')}`} small
              run={(reason, pin) => supabase.rpc('admin_delete_trip', { session_token: token, actor_pin: pin, trip_id: t.id, reason })}
              onDone={() => void refresh()} />
          </div>
        )}
        {!isAdmin && t.excluded_from_analysis && <div className="excl-tag">לא נכלל בניתוח</div>}

        <div className="hist-foot">
          <span className="muted">עובד: {nameById.get(t.worker_id) ?? 'לא ידוע'}</span>
          <button className="log-toggle" onClick={() => setOpenLog(logOpen ? null : t.id)}>
            {logOpen ? '▾' : '▸'} audit log ({t.audit_log.length})
          </button>
        </div>
        {logOpen && <ul className="audit-log">{t.audit_log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </div>
    )
  }

  function renderDuty(d: DutyShift) {
    const a = d.actual
    const logOpen = openLog === d.id
    return (
      <div className="card" key={`d-${d.id}`}>
        <div className="task-card-top">
          <span className="trip-assets"><span className="kind-dot duty">🛡️</span><strong>{d.duty_type_label}</strong> · <span className="code">{d.site_id}</span></span>
          <span className="muted">{a?.completed_at ? fmtDateTime(a.completed_at) : ''}</span>
        </div>
        <div className="task-card-meta" style={{ marginTop: 10 }}>
          <span>מתוכנן: {fmtDateTime(d.start_time)} – {fmtDateTime(d.end_time)}</span>
          <span>בפועל: {a?.actual_start ? fmtDateTime(a.actual_start) : '—'} – {a?.actual_end ? fmtDateTime(a.actual_end) : '—'}</span>
        </div>
        {a?.anomaly_found && <div className="reason-box"><strong>חריג:</strong> {a.anomaly_notes || '—'}</div>}
        {d.checklist_note && <div className="notes-box"><div>דילוג: {d.checklist_note}</div></div>}

        {isAdmin && (
          <div className="admin-row">
            <AnalysisToggle excluded={!!d.excluded_from_analysis} reason={d.excluded_reason ?? null}
              onSet={(ex, rs) => setDutyExcl(d.id, ex, rs)} />
            <DeleteAction label={`משמרת ${d.duty_type_label}`} small
              run={(reason, pin) => supabase.rpc('admin_delete_duty_shift', { session_token: token, actor_pin: pin, duty_shift_id: d.id, reason })}
              onDone={() => void refresh()} />
          </div>
        )}
        {!isAdmin && d.excluded_from_analysis && <div className="excl-tag">לא נכלל בניתוח</div>}

        <div className="hist-foot">
          <span className="muted">עובד: {nameById.get(d.worker_id) ?? 'לא ידוע'}</span>
          <button className="log-toggle" onClick={() => setOpenLog(logOpen ? null : d.id)}>
            {logOpen ? '▾' : '▸'} audit log ({d.audit_log.length})
          </button>
        </div>
        {logOpen && <ul className="audit-log">{d.audit_log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </div>
    )
  }
}

function AnalysisToggle({
  excluded, reason, onSet,
}: {
  excluded: boolean
  reason: string | null
  onSet: (excluded: boolean, reason: string) => Promise<void>
}) {
  const [openForm, setOpenForm] = useState(false)
  const [r, setR] = useState('')
  const [busy, setBusy] = useState(false)

  if (excluded) {
    return (
      <div className="excl-box">
        <span className="excl-tag">לא נכלל בניתוח{reason ? `: ${reason}` : ''}</span>
        <button className="btn sm ghost" disabled={busy} onClick={async () => { setBusy(true); await onSet(false, ''); setBusy(false) }}>כלול שוב</button>
      </div>
    )
  }
  if (!openForm) {
    return <button className="btn sm ghost" onClick={() => setOpenForm(true)}>אל תכלול בניתוח</button>
  }
  return (
    <div className="excl-form">
      <input type="text" value={r} onChange={(e) => setR(e.target.value)} placeholder="סיבה" />
      <button className="btn sm" disabled={busy || r.trim() === ''} onClick={async () => { setBusy(true); await onSet(true, r.trim()); setBusy(false); setOpenForm(false); setR('') }}>שמור</button>
      <button className="btn sm ghost" onClick={() => setOpenForm(false)}>ביטול</button>
    </div>
  )
}
