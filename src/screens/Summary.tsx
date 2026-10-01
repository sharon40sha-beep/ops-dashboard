import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import DutySummary from './DutySummary'
import type { AssetSummary, JointPair } from '../types'

function isoLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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
            <span className="bar-val">
              {it.count} · {total > 0 ? Math.round((it.count / total) * 100) : 0}%
            </span>
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(it.count / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Summary() {
  const { token, logout } = useAuth()
  const { assets } = useData()
  const activeAssets = useMemo(() => assets.filter((a) => a.is_active !== false), [assets])

  const [view, setView] = useState<'trips' | 'duties'>('trips')
  const [assetId, setAssetId] = useState('')
  const [period, setPeriod] = useState<Period>('30')
  const [from, setFrom] = useState(isoLocal(new Date(Date.now() - 30 * 864e5)))
  const [to, setTo] = useState(isoLocal(new Date()))
  const [data, setData] = useState<AssetSummary | null>(null)
  const [joint, setJoint] = useState<JointPair[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const effectiveAsset = assetId || activeAssets[0]?.id || ''

  function applyPeriod(p: Period) {
    setPeriod(p)
    if (p !== 'custom') {
      setFrom(isoLocal(new Date(Date.now() - Number(p) * 864e5)))
      setTo(isoLocal(new Date()))
    }
  }

  const load = useCallback(async () => {
    if (!token || !effectiveAsset) return
    setLoading(true)
    setErr('')
    const { data: res, error } = await supabase.rpc('admin_asset_summary', {
      session_token: token,
      asset_id: effectiveAsset,
      from_date: from,
      to_date: to,
    })
    setLoading(false)
    if (error) {
      if (error.message.includes('session')) return logout()
      setErr(error.message)
      return
    }
    setData(res as AssetSummary)
  }, [token, effectiveAsset, from, to, logout])

  useEffect(() => {
    void load()
  }, [load])

  // D: joint movement (period-scoped, all assets)
  useEffect(() => {
    if (!token) return
    void supabase
      .rpc('admin_joint_movement_summary', { session_token: token, from_date: from, to_date: to })
      .then(({ data: res, error }) => {
        if (!error) setJoint((res as JointPair[]) ?? [])
      })
  }, [token, from, to])

  const hourItems = useMemo(
    () => (data?.hours ?? []).map((h) => ({ key: `${String(h.hour).padStart(2, '0')}:00`, count: h.count })),
    [data],
  )

  return (
    <div>
      <div className="segmented" style={{ marginBottom: 14 }}>
        <button className={view === 'trips' ? 'active' : ''} onClick={() => setView('trips')}>🚚 מוצרים (נסיעות)</button>
        <button className={view === 'duties' ? 'active' : ''} onClick={() => setView('duties')}>🛡️ אתרים (משמרות)</button>
      </div>

      {view === 'duties' ? <DutySummary /> : (
      <>
      <div className="card">
        <h2>לוח למידה — לפי מוצר</h2>
        <label>מוצר</label>
        <select value={effectiveAsset} onChange={(e) => setAssetId(e.target.value)}>
          {activeAssets.length === 0 && <option value="">אין מוצרים</option>}
          {activeAssets.map((a) => (
            <option key={a.id} value={a.id}>{a.id}</option>
          ))}
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
            <div style={{ flex: 1 }}>
              <label>מ־</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label>עד</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        )}
        {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
      </div>

      {loading && <div className="center-screen" style={{ minHeight: 120 }}>טוען…</div>}

      {!loading && data && (
        <>
          <div className="card">
            <div className="stats">
              <div className="stat">
                <div className="value">{data.total}</div>
                <div className="label">משימות שהושלמו</div>
              </div>
              <div className="stat">
                <div className="value">
                  {data.deviated} · {data.total > 0 ? Math.round((data.deviated / data.total) * 100) : 0}%
                </div>
                <div className="label">עם סטייה מהמתוכנן</div>
              </div>
            </div>
          </div>

          <Bars title="שעות יציאה" items={hourItems} total={data.total} />
          <Bars title="לפי רכב" items={data.by_vehicle} total={data.total} />
          <Bars title="לפי ציר" items={data.by_route} total={data.total} />
          <Bars title="לפי עובד" items={data.by_worker} total={data.total} />
        </>
      )}

      <div className="card">
        <h2>תנועה משותפת (כל המוצרים בתקופה)</h2>
        <p className="muted">כמה פעמים כל צמד מוצרים נסע באותה נסיעה, ומה האחוז מנסיעות כל אחד.</p>
        {joint.length === 0 && <p className="muted">אין נתונים בתקופה.</p>}
        {joint.length > 0 && (
          <div className="joint-grid">
            <div className="joint-head">צמד</div>
            <div className="joint-head">משותף</div>
            <div className="joint-head">% מ-א׳</div>
            <div className="joint-head">% מ-ב׳</div>
            {joint.map((p) => (
              <div className="joint-row" key={`${p.a}-${p.b}`}>
                <div><span className="code sm">{p.a}</span> + <span className="code sm">{p.b}</span></div>
                <div>{p.joint}</div>
                <div>{p.pct_a ?? 0}%</div>
                <div>{p.pct_b ?? 0}%</div>
              </div>
            ))}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  )
}
