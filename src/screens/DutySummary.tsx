import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { siteKindHe } from '../lib/ops'
import type { DutySummary as DutySummaryT } from '../types'

function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
type Period = '7' | '30' | '90' | 'custom'

function Bars({ title, items, total }: { title: string; items: { key: string; count: number }[]; total: number }) {
  const max = Math.max(1, ...items.map((i) => i.count))
  return (
    <div className="card">
      <h2>{title}</h2>
      {items.length === 0 && <p className="muted">אין נתונים</p>}
      {items.map((it) => (
        <div className="bar-row" key={it.key}>
          <div className="bar-head">
            <span className="bar-key">{it.key}</span>
            <span className="bar-val">{it.count} · {total > 0 ? Math.round((it.count / total) * 100) : 0}%</span>
          </div>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(it.count / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  )
}

export default function DutySummary() {
  const { token, logout } = useAuth()
  const { sites } = useData()
  const activeSites = useMemo(() => sites.filter((s) => s.is_active !== false), [sites])

  const [siteId, setSiteId] = useState('')
  const [period, setPeriod] = useState<Period>('30')
  const [from, setFrom] = useState(isoLocal(new Date(Date.now() - 30 * 864e5)))
  const [to, setTo] = useState(isoLocal(new Date()))
  const [data, setData] = useState<DutySummaryT | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const effectiveSite = siteId || activeSites[0]?.id || ''

  function applyPeriod(p: Period) {
    setPeriod(p)
    if (p !== 'custom') {
      setFrom(isoLocal(new Date(Date.now() - Number(p) * 864e5)))
      setTo(isoLocal(new Date()))
    }
  }

  const load = useCallback(async () => {
    if (!token || !effectiveSite) return
    setLoading(true); setErr('')
    const { data: res, error } = await supabase.rpc('admin_duty_summary', {
      session_token: token, site_id: effectiveSite, from_date: from, to_date: to,
    })
    setLoading(false)
    if (error) { if (error.message.includes('session')) return logout(); setErr(error.message); return }
    setData(res as DutySummaryT)
  }, [token, effectiveSite, from, to, logout])

  useEffect(() => { void load() }, [load])

  return (
    <div>
      <div className="card">
        <h2>סיכום משמרות — לפי אתר</h2>
        <label>אתר</label>
        <select value={effectiveSite} onChange={(e) => setSiteId(e.target.value)}>
          {activeSites.length === 0 && <option value="">אין אתרים</option>}
          {activeSites.map((s) => <option key={s.id} value={s.id}>{s.id} · {siteKindHe(s.kind)}</option>)}
        </select>
        <label>תקופה</label>
        <div className="segmented">
          {(['7', '30', '90', 'custom'] as Period[]).map((p) => (
            <button key={p} className={p === period ? 'active' : ''} onClick={() => applyPeriod(p)}>
              {p === 'custom' ? 'טווח' : `${p} ימים`}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
            <div style={{ flex: 1 }}><label>מ־</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div style={{ flex: 1 }}><label>עד</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
        )}
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
      </div>

      {loading && <div className="center-screen" style={{ minHeight: 120 }}>טוען…</div>}

      {!loading && data && (
        <>
          <div className="card">
            <div className="stats">
              <div className="stat"><div className="value">{data.total}</div><div className="label">משמרות שהושלמו</div></div>
              <div className="stat"><div className="value">{data.anomalies} · {data.total > 0 ? Math.round((data.anomalies / data.total) * 100) : 0}%</div><div className="label">עם חריג</div></div>
            </div>
          </div>
          <Bars title="לפי סוג משמרת" items={data.by_type} total={data.total} />
          <Bars title="לפי עובד" items={data.by_worker} total={data.total} />
        </>
      )}
    </div>
  )
}
