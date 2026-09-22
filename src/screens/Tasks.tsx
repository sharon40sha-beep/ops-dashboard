import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { auditLine, siteKindHe } from '../lib/ops'
import type { ChecklistItem, Site, Task, TaskActual } from '../types'
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

const STATUS_HE: Record<Task['status'], string> = {
  planned: 'מתוכננת',
  active: 'פעילה',
  completed: 'הושלמה',
}

export default function Tasks() {
  const { session } = useAuth()
  const { tasks, sitesById, employees, loading, refresh } = useData()
  const [openId, setOpenId] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    employees.forEach((e) => m.set(e.id, e.name))
    return m
  }, [employees])

  // Operator: own non-completed tasks. Admin: all non-completed.
  const list = useMemo(
    () =>
      tasks.filter((t) => {
        if (t.status === 'completed') return false
        if (session?.role === 'operator') return t.worker_id === session.employeeId
        return true
      }),
    [tasks, session],
  )

  const open = openId ? tasks.find((t) => t.id === openId) : null

  if (loading && tasks.length === 0) return <div className="center-screen">טוען…</div>

  if (open && open.status !== 'completed') {
    return (
      <>
        <TaskDetail
          task={open}
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
            setToast('המשימה הושלמה')
          }}
        />
        {toast && <Toast message={toast} onDone={() => setToast('')} />}
      </>
    )
  }

  return (
    <div>
      <div className="card">
        <h2>משימות פעילות ({list.length})</h2>
        {list.length === 0 && <p className="muted">אין משימות פעילות.</p>}
        <div className="chips" style={{ flexDirection: 'column' }}>
          {list.map((t) => (
            <button key={t.id} className="task-card" onClick={() => setOpenId(t.id)}>
              <div className="task-card-top">
                <span className="code">{t.asset_id}</span>
                <span className={`status-pill status-${t.status}`}>{STATUS_HE[t.status]}</span>
              </div>
              <div className="route-line">
                <SiteLabel id={t.from_site_id} sitesById={sitesById} />
                <span className="arrow">←</span>
                <SiteLabel id={t.to_site_id} sitesById={sitesById} />
              </div>
              <div className="task-card-meta">
                {t.route && (
                  <span>
                    ציר: <strong>{t.route}</strong>
                  </span>
                )}
                {t.vehicle && (
                  <span>
                    רכב: <span className="code sm">{t.vehicle}</span>
                  </span>
                )}
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

function TaskDetail({
  task,
  sitesById,
  workerName,
  onBack,
  onSaved,
  onCompleted,
}: {
  task: Task
  sitesById: Map<string, Site>
  workerName?: string
  onBack: () => void
  onSaved: (msg?: string) => void
  onCompleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // complete-form state (only used when status === 'active')
  const [showComplete, setShowComplete] = useState(false)
  const [vehicle, setVehicle] = useState(task.vehicle)
  const [route, setRoute] = useState(task.route)
  const [reason, setReason] = useState('')

  const deviated = vehicle.trim() !== task.vehicle.trim() || route.trim() !== task.route.trim()
  const allChecked = task.checklist.length > 0 && task.checklist.every((c) => c.checked)

  async function patch(fields: Partial<Task>, doneMsg?: string) {
    setErr('')
    setBusy(true)
    const { error } = await supabase.from('tasks').update(fields).eq('id', task.id)
    setBusy(false)
    if (error) {
      setErr(error.message)
      return false
    }
    onSaved(doneMsg)
    return true
  }

  async function toggle(idx: number) {
    const checklist: ChecklistItem[] = task.checklist.map((c, i) =>
      i === idx ? { ...c, checked: !c.checked } : c,
    )
    await patch({ checklist })
  }

  async function start() {
    await patch(
      { status: 'active', audit_log: [...task.audit_log, auditLine('Task started')] },
      'המשימה הופעלה',
    )
  }

  async function complete() {
    if (deviated && reason.trim() === '') {
      setErr('זוהתה סטייה מהמתוכנן — חובה למלא סיבה לפני שמירה.')
      return
    }
    const actual: TaskActual = {
      vehicle: vehicle.trim(),
      route: route.trim(),
      completed_at: new Date().toISOString(),
      deviated,
      reason: deviated ? reason.trim() : '',
    }
    setErr('')
    setBusy(true)
    const { error } = await supabase
      .from('tasks')
      .update({
        status: 'completed',
        actual,
        audit_log: [
          ...task.audit_log,
          auditLine(deviated ? 'Task completed (deviation logged)' : 'Task completed'),
        ],
      })
      .eq('id', task.id)
    setBusy(false)
    if (error) {
      setErr(error.message)
      return
    }
    onCompleted()
  }

  return (
    <div>
      <button className="btn secondary" onClick={onBack} style={{ marginTop: 0 }}>
        ‹ חזרה למשימות
      </button>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="task-card-top">
          <span className="code">{task.asset_id}</span>
          <span className={`status-pill status-${task.status}`}>{STATUS_HE[task.status]}</span>
        </div>
        <div className="route-line big">
          <SiteLabel id={task.from_site_id} sitesById={sitesById} />
          <span className="arrow">←</span>
          <SiteLabel id={task.to_site_id} sitesById={sitesById} />
        </div>
        <div className="task-card-meta">
          {task.route && (
            <span>
              ציר מתוכנן: <strong>{task.route}</strong>
            </span>
          )}
          {task.vehicle && (
            <span>
              רכב מתוכנן: <span className="code sm">{task.vehicle}</span>
            </span>
          )}
          {task.time_window && <span>חלון זמן: {task.time_window}</span>}
          {workerName && <span>עובד: {workerName}</span>}
        </div>
      </div>

      {task.status === 'planned' && (
        <div className="card">
          <h2>צ'קליסט יציאה</h2>
          <div className="checklist">
            {task.checklist.map((c, i) => (
              <button
                key={i}
                className={`check-row ${c.checked ? 'checked' : ''}`}
                onClick={() => void toggle(i)}
                disabled={busy}
              >
                <span className="check-box" />
                <span className="check-label">{c.label}</span>
              </button>
            ))}
          </div>
          {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
          <button className="btn" onClick={() => void start()} disabled={!allChecked || busy}>
            {busy ? 'שומר…' : 'התחל משימה'}
          </button>
          {!allChecked && <p className="muted" style={{ textAlign: 'center', marginTop: 8 }}>יש לסמן את כל הסעיפים כדי להתחיל</p>}
        </div>
      )}

      {task.status === 'active' && (
        <div className="card">
          <div className="gps">
            <span className="gps-pulse" />
            <span className="gps-text">GPS פעיל</span>
          </div>

          {!showComplete ? (
            <button className="btn" onClick={() => setShowComplete(true)}>
              השלם משימה
            </button>
          ) : (
            <>
              <h2 style={{ marginTop: 4 }}>השלמת משימה — נתונים בפועל</h2>

              <label>רכב בפועל</label>
              <input
                className="mono"
                type="text"
                value={vehicle}
                placeholder={task.vehicle}
                onChange={(e) => setVehicle(e.target.value)}
              />

              <label>ציר בפועל</label>
              <input
                className="mono"
                type="text"
                value={route}
                placeholder={task.route}
                onChange={(e) => setRoute(e.target.value)}
              />

              {deviated && (
                <>
                  <label>סיבת סטייה *</label>
                  <input
                    type="text"
                    value={reason}
                    placeholder="מדוע הרכב/ציר שונה מהמתוכנן?"
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <p className="muted" style={{ color: 'var(--accent)', marginTop: 8 }}>
                    זוהתה סטייה מהמתוכנן — חובה למלא סיבה.
                  </p>
                </>
              )}

              {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}

              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn ghost" onClick={() => setShowComplete(false)} disabled={busy}>
                  ביטול
                </button>
                <button className="btn" onClick={() => void complete()} disabled={busy}>
                  {busy ? 'שומר…' : 'שמור והשלם'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
