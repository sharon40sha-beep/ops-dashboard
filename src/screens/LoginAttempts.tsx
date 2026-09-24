import { useState } from 'react'
import { supabase } from '../utils/supabase'
import { fmtDateTime, loginReasonHe } from '../lib/ops'
import type { LoginAttempt } from '../types'

export default function LoginAttempts() {
  const [gatePw, setGatePw] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [rows, setRows] = useState<LoginAttempt[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  async function load(actorPw: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('admin_list_login_attempts', {
      actor_pin: actorPw,
      limit_count: 100,
    })
    if (error) return false
    setRows((data as LoginAttempt[]) ?? [])
    return true
  }

  async function unlock() {
    setErr('')
    setLoading(true)
    const ok = await load(gatePw)
    setLoading(false)
    if (!ok) {
      setErr('סיסמה שגויה או שאינה שייכת למנהל פעיל')
      return
    }
    setUnlocked(true)
  }

  if (!unlocked) {
    return (
      <div>
        <div className="card">
          <h2>לוג כניסות — אימות מנהל</h2>
          <p className="muted">מסך זה חשוף למנהלים בלבד. הזן/י את סיסמתך כדי לצפות בלוג.</p>
          <label>סיסמת מנהל</label>
          <input
            type="password"
            value={gatePw}
            onChange={(e) => setGatePw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void unlock()
            }}
            placeholder="סיסמה"
          />
          {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
          <button className="btn" onClick={() => void unlock()} disabled={loading || gatePw === ''}>
            {loading ? 'טוען…' : 'הצג לוג'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="card">
        <div className="card-head-row">
          <h2 style={{ margin: 0 }}>לוג כניסות ({rows.length})</h2>
          <button className="btn secondary sm" onClick={() => void load(gatePw)}>
            רענן
          </button>
        </div>
        {rows.length === 0 && <p className="muted">אין רשומות.</p>}
        {rows.map((a) => (
          <div className="list-item" key={a.id}>
            <div>
              <div className="title">{a.employee_name ?? '— לא מזוהה —'}</div>
              <div className="sub">
                {fmtDateTime(a.attempted_at)}
                {!a.success && a.reason ? ` · ${loginReasonHe(a.reason, false)}` : ''}
              </div>
            </div>
            <span className={`badge ${a.success ? 'ok' : 'fail'}`}>{a.success ? 'הצלחה' : 'כישלון'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
