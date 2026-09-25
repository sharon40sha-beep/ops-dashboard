import { useMemo, useState } from 'react'
import { useData } from '../context/DataContext'
import { fmtDateTime, siteKindHe } from '../lib/ops'
import type { Task } from '../types'

export default function History() {
  // history is already scoped per-user by the list_task_history RPC.
  const { history: completed, sitesById, employees } = useData()
  const [openLog, setOpenLog] = useState<string | null>(null)

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    employees.forEach((e) => m.set(e.id, e.name))
    return m
  }, [employees])

  function siteText(id: string): string {
    const kind = sitesById.get(id)?.kind
    return kind ? `${id} · ${siteKindHe(kind)}` : id
  }

  return (
    <div>
      <div className="card">
        <h2>משימות שהושלמו ({completed.length})</h2>
        {completed.length === 0 && <p className="muted">אין משימות שהושלמו.</p>}
      </div>

      {completed.map((t) => {
        const a = t.actual
        const vDiff = a ? a.vehicle.trim() !== t.vehicle.trim() : false
        const rDiff = a ? a.route.trim() !== t.route.trim() : false
        const logOpen = openLog === t.id
        return (
          <div className="card" key={t.id}>
            <div className="task-card-top">
              <span className="code">{t.asset_id}</span>
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

              <div className="pa-cell">
                רכב: <span className="code sm">{t.vehicle || '—'}</span>
              </div>
              <div className={`pa-cell ${vDiff ? 'diff' : ''}`}>
                רכב: <span className="code sm">{a?.vehicle || '—'}</span>
              </div>

              <div className="pa-cell">
                ציר: <strong>{t.route || '—'}</strong>
              </div>
              <div className={`pa-cell ${rDiff ? 'diff' : ''}`}>
                ציר: <strong>{a?.route || '—'}</strong>
              </div>
            </div>

            {a?.deviated && (
              <div className="reason-box">
                <strong>סיבת סטייה:</strong> {a.reason || '—'}
              </div>
            )}

            <div className="hist-foot">
              <span className="muted">עובד: {nameById.get(t.worker_id) ?? 'לא ידוע'}</span>
              <button className="log-toggle" onClick={() => setOpenLog(logOpen ? null : t.id)}>
                {logOpen ? '▾' : '▸'} audit log ({t.audit_log.length})
              </button>
            </div>
            {logOpen && <AuditLog task={t} />}
          </div>
        )
      })}
    </div>
  )
}

function AuditLog({ task }: { task: Task }) {
  return (
    <ul className="audit-log">
      {task.audit_log.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  )
}
