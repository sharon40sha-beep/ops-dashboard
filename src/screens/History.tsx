import { useMemo, useState } from 'react'
import { useData } from '../context/DataContext'
import { fmtDateTime, siteKindHe } from '../lib/ops'
import type { Trip } from '../types'

export default function History() {
  const { history, trips, sitesById } = useData()
  const [openLog, setOpenLog] = useState<string | null>(null)

  // trip label + return-link maps (across open + completed trips we know about)
  const all = useMemo(() => [...history, ...trips], [history, trips])
  const labelById = useMemo(() => {
    const m = new Map<string, string>()
    all.forEach((t) => m.set(t.id, `${t.items.map((i) => i.asset_id).join(',')} · ${t.from_site_id}←${t.to_site_id}`))
    return m
  }, [all])
  // outbound trip id -> its return trip (reverse of return_of_trip_id)
  const returnByOutbound = useMemo(() => {
    const m = new Map<string, Trip>()
    all.forEach((t) => {
      if (t.return_of_trip_id) m.set(t.return_of_trip_id, t)
    })
    return m
  }, [all])

  function siteText(id: string): string {
    const kind = sitesById.get(id)?.kind
    return kind ? `${id} · ${siteKindHe(kind)}` : id
  }

  return (
    <div>
      <div className="card">
        <h2>נסיעות שהושלמו ({history.length})</h2>
        {history.length === 0 && <p className="muted">אין נסיעות שהושלמו.</p>}
      </div>

      {history.map((t) => {
        const a = t.actual
        const vDiff = a ? (a.vehicle ?? '').trim() !== (t.vehicle_id ?? '').trim() : false
        const rDiff = a ? (a.route ?? '').trim() !== (t.route_id ?? '').trim() : false
        const logOpen = openLog === t.id
        const ret = returnByOutbound.get(t.id)
        return (
          <div className="card" key={t.id}>
            <div className="task-card-top">
              <span className="trip-assets">
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

            {t.return_of_trip_id && (
              <div className="link-box">↔ חזרה של: {labelById.get(t.return_of_trip_id) ?? 'נסיעה'}</div>
            )}
            {ret && <div className="link-box">↔ נסיעת חזרה: {labelById.get(ret.id) ?? 'נסיעה'}</div>}

            {t.items.some((it) => it.checklist_note) && (
              <div className="notes-box">
                {t.items.filter((it) => it.checklist_note).map((it) => (
                  <div key={it.id}><span className="code sm">{it.asset_id}</span> — דילוג: {it.checklist_note}</div>
                ))}
              </div>
            )}

            <div className="hist-foot">
              <span className="muted">מוצרים: {t.items.length}</span>
              <button className="log-toggle" onClick={() => setOpenLog(logOpen ? null : t.id)}>
                {logOpen ? '▾' : '▸'} audit log ({t.audit_log.length})
              </button>
            </div>
            {logOpen && (
              <ul className="audit-log">
                {t.audit_log.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
