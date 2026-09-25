import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import { retryText } from '../lib/ops'
import type { Employee, Role } from '../types'

/** Row shape returned by verify_pin() — id set on success; retry set when locked. */
interface VerifyRow {
  id: string | null
  name: string | null
  role: Role | null
  locked_until: string | null
  retry_after_seconds: number | null
  session_token: string | null
}

export default function Login() {
  const { login } = useAuth()
  const { employees, loading, error } = useData()
  const [selected, setSelected] = useState<Employee | null>(null)
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function submit() {
    if (!selected || password === '' || busy) return
    setBusy(true)
    setMsg('')
    const { data, error: rpcError } = await supabase.rpc('verify_pin', {
      emp_id: selected.id,
      pin_input: password,
    })
    setBusy(false)

    if (rpcError) {
      setMsg('שגיאת התחברות: ' + rpcError.message)
      return
    }
    const row = (Array.isArray(data) ? data[0] : undefined) as VerifyRow | undefined

    if (row && row.id && row.name && row.role && row.session_token) {
      // verify_pin mints one server session for every employee and returns the
      // token; it is used for all subsequent RPC calls.
      login({ employeeId: row.id, name: row.name, role: row.role }, row.session_token)
      return
    }
    if (row && row.retry_after_seconds != null) {
      setPassword('')
      setMsg(`החשבון נעול עקב ניסיונות כושלים. נסה/י שוב ${retryText(row.retry_after_seconds)}`)
      return
    }
    setPassword('')
    setMsg('שם משתמש או סיסמה שגויים')
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div className="login-wrap">
      <div className="login-logo">
        <div className="mark">OPS</div>
        <h1>OPS Dashboard</h1>
        <p className="muted">בחר/י את שמך והזן/י סיסמה</p>
      </div>

      {error && <div className="error-banner">לא ניתן לטעון עובדים: {error}</div>}

      {!selected ? (
        <div className="emp-grid">
          {employees.length === 0 && !error && (
            <p className="muted">אין עובדים עדיין. הרץ/י את סקריפט ה-seed ב-Supabase.</p>
          )}
          {employees.map((e) => (
            <button key={e.id} className="emp-btn" onClick={() => setSelected(e)}>
              {e.name}
              <span className={`role-badge role-${e.role}`} style={{ display: 'block', marginTop: 6 }}>
                {e.role === 'admin' ? 'מנהל' : 'מפעיל'}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div>
          <button
            className="emp-btn active"
            style={{ width: '100%' }}
            onClick={() => {
              setSelected(null)
              setPassword('')
              setMsg('')
            }}
          >
            {selected.name} — החלפה
          </button>

          <label>סיסמה</label>
          <div className="pw-field">
            <input
              type={show ? 'text' : 'password'}
              value={password}
              autoFocus
              onChange={(e) => {
                setPassword(e.target.value)
                setMsg('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit()
              }}
              placeholder="הזן/י סיסמה"
            />
            <button type="button" className="pw-toggle" onClick={() => setShow((s) => !s)} aria-label="הצג/הסתר סיסמה">
              {show ? '🙈' : '👁️'}
            </button>
          </div>

          {msg && <div className="error-banner" style={{ marginTop: 12 }}>{msg}</div>}

          <button className="btn" onClick={() => void submit()} disabled={busy || password === ''}>
            {busy ? 'בודק…' : 'כניסה'}
          </button>
        </div>
      )}
    </div>
  )
}
