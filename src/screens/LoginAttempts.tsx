import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../utils/supabase'
import { fmtDateTime, loginReasonHe } from '../lib/ops'
import type { LoginAttempt } from '../types'

export default function LoginAttempts() {
  const { token, logout } = useAuth()
  const [rows, setRows] = useState<LoginAttempt[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!token) {
      logout()
      return
    }
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_login_attempts', {
      session_token: token,
      limit_count: 100,
    })
    setLoading(false)
    if (error) {
      logout()
      return
    }
    setRows((data as LoginAttempt[]) ?? [])
  }, [token, logout])

  useEffect(() => {
    void load()
  }, [load])

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
