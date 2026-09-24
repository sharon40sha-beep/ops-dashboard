import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../utils/supabase'
import { fmtDateTime, loginReasonHe } from '../lib/ops'
import type { LoginAttempt } from '../types'

export default function LoginAttempts() {
  const { adminToken, setAdminToken } = useAuth()
  const [rows, setRows] = useState<LoginAttempt[]>([])
  const [loading, setLoading] = useState(true)

  const [needAuth, setNeedAuth] = useState(false)
  const [authPw, setAuthPw] = useState('')
  const [authErr, setAuthErr] = useState('')
  const [authBusy, setAuthBusy] = useState(false)

  const load = useCallback(async () => {
    if (!adminToken) {
      setNeedAuth(true)
      setLoading(false)
      return
    }
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_login_attempts', {
      session_token: adminToken,
      limit_count: 100,
    })
    setLoading(false)
    if (error) {
      setAdminToken(null)
      setNeedAuth(true)
      return
    }
    setRows((data as LoginAttempt[]) ?? [])
    setNeedAuth(false)
  }, [adminToken, setAdminToken])

  useEffect(() => {
    void load()
  }, [load])

  async function reauth() {
    setAuthErr('')
    setAuthBusy(true)
    const { data } = await supabase.rpc('admin_login', { pin: authPw })
    setAuthBusy(false)
    const token = (Array.isArray(data) ? data[0]?.token : undefined) as string | undefined
    if (!token) {
      setAuthErr('סיסמה שגויה או שאינה שייכת למנהל פעיל')
      return
    }
    setAuthPw('')
    setAdminToken(token)
  }

  if (needAuth) {
    return (
      <div>
        <div className="card">
          <h2>לוג כניסות — אימות מנהל</h2>
          <p className="muted">פג תוקף החיבור או שאינך מחובר כמנהל. הזן/י את סיסמתך.</p>
          <label>סיסמת מנהל</label>
          <input
            type="password"
            value={authPw}
            onChange={(e) => setAuthPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void reauth()
            }}
            placeholder="סיסמה"
          />
          {authErr && <div className="error-banner" style={{ marginTop: 12 }}>{authErr}</div>}
          <button className="btn" onClick={() => void reauth()} disabled={authBusy || authPw === ''}>
            {authBusy ? 'בודק…' : 'התחבר'}
          </button>
        </div>
      </div>
    )
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div>
      <div className="card">
        <div className="card-head-row">
          <h2 style={{ margin: 0 }}>לוג כניסות ({rows.length})</h2>
          <button className="btn secondary sm" onClick={() => void load()}>
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
