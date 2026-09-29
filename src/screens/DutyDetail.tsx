import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { fmtDateTime, toLocalInput, localToIso } from '../lib/ops'
import type { ChecklistItem, DutyShift } from '../types'
import DeleteAction from '../components/DeleteAction'

const STATUS_HE: Record<DutyShift['status'], string> = {
  planned: 'מתוכננת',
  active: 'פעילה',
  completed: 'הושלמה',
}

export default function DutyDetail({
  duty,
  onBack,
  onSaved,
  onCompleted,
  onDeleted,
}: {
  duty: DutyShift
  onBack: () => void
  onSaved: (msg?: string) => void
  onCompleted: () => void
  onDeleted: () => void
}) {
  const { token, session, logout } = useAuth()
  const { employees } = useData()
  const workerName = useMemo(() => employees.find((e) => e.id === duty.worker_id)?.name, [employees, duty.worker_id])

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // planned: single checklist + note
  const [checklist, setChecklist] = useState<ChecklistItem[]>(duty.checklist)
  const [note, setNote] = useState(duty.checklist_note ?? '')

  // active: complete form
  const [showComplete, setShowComplete] = useState(false)
  const [actualStart, setActualStart] = useState(toLocalInput(duty.start_time))
  const [actualEnd, setActualEnd] = useState(toLocalInput(duty.end_time))
  const [anomaly, setAnomaly] = useState(false)
  const [anomalyNotes, setAnomalyNotes] = useState('')

  const hasUnchecked = checklist.some((c) => !c.checked)
  const canStart = !busy && (!hasUnchecked || note.trim() !== '')

  function onRpcError(m: string) {
    if (m.includes('session')) return logout()
    setErr(translateDutyErr(m))
  }

  async function persist(nextChecklist: ChecklistItem[], nextNote: string) {
    if (!token) return
    const { error } = await supabase.rpc('update_duty_checklist', {
      session_token: token,
      duty_shift_id: duty.id,
      p_checklist: nextChecklist,
      p_note: nextNote.trim() === '' ? null : nextNote.trim(),
    })
    if (error) onRpcError(error.message)
  }

  async function toggle(idx: number) {
    const next = checklist.map((c, i) => (i === idx ? { ...c, checked: !c.checked } : c))
    setChecklist(next)
    await persist(next, note)
  }

  async function start() {
    if (!token) return
    setErr(''); setBusy(true)
    const { error } = await supabase.rpc('start_duty', { session_token: token, duty_shift_id: duty.id })
    setBusy(false)
    if (error) return onRpcError(error.message)
    onSaved('המשמרת הופעלה')
  }

  async function complete() {
    if (!token) return
    if (anomaly && anomalyNotes.trim() === '') {
      setErr('סומן "נמצא חריג" — חובה למלא פירוט.')
      return
    }
    setErr(''); setBusy(true)
    const { error } = await supabase.rpc('complete_duty', {
      session_token: token,
      duty_shift_id: duty.id,
      p_actual: {
        actual_start: localToIso(actualStart),
        actual_end: localToIso(actualEnd),
        anomaly_found: anomaly,
        anomaly_notes: anomalyNotes.trim(),
      },
    })
    setBusy(false)
    if (error) return onRpcError(error.message)
    onCompleted()
  }

  const ordered = checklist
    .map((c, i) => ({ c, i }))
    .sort((a, b) => Number(b.c.critical ?? false) - Number(a.c.critical ?? false))

  return (
    <div>
      <div className="detail-topbar">
        <button className="btn secondary" onClick={onBack} style={{ marginTop: 0 }}>‹ חזרה לרשימה</button>
        {session?.role === 'admin' && (
          <DeleteAction label={`משמרת ${duty.duty_type_label} · ${duty.site_id}`}
            run={(reason, pin) => supabase.rpc('admin_delete_duty_shift', { session_token: token, actor_pin: pin, duty_shift_id: duty.id, reason })}
            onDone={onDeleted} />
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="task-card-top">
          <span className="kind-tag-lg">🛡️ משמרת</span>
          <span className={`status-pill status-${duty.status}`}>{STATUS_HE[duty.status]}</span>
        </div>
        <div className="route-line big"><strong>{duty.duty_type_label}</strong> · <span className="code">{duty.site_id}</span></div>
        <div className="task-card-meta">
          <span>מ־{fmtDateTime(duty.start_time)}</span>
          <span>עד {fmtDateTime(duty.end_time)}</span>
          {workerName && <span>עובד: {workerName}</span>}
        </div>
      </div>

      {duty.status === 'planned' && (
        <div className="card">
          <h2>צ׳קליסט</h2>
          <div className="checklist">
            {ordered.map(({ c, i }) => (
              <button key={i} className={`check-row ${c.checked ? 'checked' : ''}`} onClick={() => void toggle(i)} disabled={busy}>
                <span className="check-box" />
                <span className="check-label">{c.label}</span>
                {c.critical && <span className="crit-badge">קריטי</span>}
              </button>
            ))}
            {checklist.length === 0 && <p className="muted">אין צ׳קליסט לסוג משמרת זה.</p>}
          </div>
          {hasUnchecked && (
            <>
              <label>יש סעיפים שלא סומנו — למה דילגת? (חובה)</label>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => void persist(checklist, note)} placeholder="הסבר קצר" />
            </>
          )}
          {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
          <button className="btn" onClick={() => void start()} disabled={!canStart}>{busy ? 'שומר…' : 'התחל משמרת'}</button>
          {!canStart && <p className="muted" style={{ textAlign: 'center', marginTop: 8 }}>מלא/י הערת דילוג כדי להתחיל</p>}
        </div>
      )}

      {duty.status === 'active' && (
        <div className="card">
          {!showComplete ? (
            <button className="btn" onClick={() => setShowComplete(true)}>סיים משמרת</button>
          ) : (
            <>
              <h2 style={{ marginTop: 4 }}>סיום משמרת</h2>
              <label>התחלה בפועל</label>
              <input type="datetime-local" value={actualStart} onChange={(e) => setActualStart(e.target.value)} />
              <label>סיום בפועל</label>
              <input type="datetime-local" value={actualEnd} onChange={(e) => setActualEnd(e.target.value)} />
              <label className="inline-check" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={anomaly} onChange={(e) => setAnomaly(e.target.checked)} />
                <span>נמצא חריג</span>
              </label>
              {anomaly && (
                <>
                  <label>פירוט החריג *</label>
                  <textarea rows={2} value={anomalyNotes} onChange={(e) => setAnomalyNotes(e.target.value)} placeholder="מה נמצא?" />
                </>
              )}
              {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn ghost" onClick={() => setShowComplete(false)} disabled={busy}>ביטול</button>
                <button className="btn" onClick={() => void complete()} disabled={busy}>{busy ? 'שומר…' : 'שמור וסיים'}</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function translateDutyErr(msg: string): string {
  if (msg.includes('skip note')) return 'יש למלא הערת דילוג'
  if (msg.includes('anomaly notes')) return 'חובה לפרט את החריג'
  if (msg.includes('not your shift')) return 'אין לך הרשאה למשמרת זו'
  if (msg.includes('not active')) return 'המשמרת אינה פעילה'
  if (msg.includes('not found')) return 'המשמרת לא נמצאה'
  return msg
}
