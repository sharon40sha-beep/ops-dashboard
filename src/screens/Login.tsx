import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { supabase } from '../utils/supabase'
import type { Employee, Role } from '../types'

const PIN_LENGTH = 4

/** Row shape returned by the verify_pin() RPC (id/name/role — never the PIN). */
interface VerifyRow {
  id: string
  name: string
  role: Role
}

export default function Login() {
  const { login } = useAuth()
  const { employees, loading, error } = useData()
  const [selected, setSelected] = useState<Employee | null>(null)
  const [pin, setPin] = useState('')
  const [wrong, setWrong] = useState(false)
  const [checking, setChecking] = useState(false)

  async function verify(fullPin: string, emp: Employee) {
    setChecking(true)
    setWrong(false)
    // PIN is verified SERVER-SIDE — the RPC returns the employee only on a
    // match, and the employees table itself is not readable by the client.
    const { data, error: rpcError } = await supabase.rpc('verify_pin', {
      emp_id: emp.id,
      pin_input: fullPin,
    })
    setChecking(false)

    const row = Array.isArray(data) ? (data[0] as VerifyRow | undefined) : undefined
    if (rpcError || !row) {
      setWrong(true)
      setTimeout(() => setPin(''), 500)
      return
    }
    login({ employeeId: row.id, name: row.name, role: row.role })
  }

  function pressDigit(d: string) {
    if (checking || pin.length >= PIN_LENGTH) return
    const next = pin + d
    setPin(next)
    setWrong(false)
    if (next.length === PIN_LENGTH && selected) void verify(next, selected)
  }

  function backspace() {
    if (checking) return
    setPin((p) => p.slice(0, -1))
    setWrong(false)
  }

  if (loading) return <div className="center-screen">טוען…</div>

  return (
    <div className="login-wrap">
      <div className="login-logo">
        <div className="mark">OPS</div>
        <h1>OPS Dashboard</h1>
        <p className="muted">בחר/י את שמך והזן/י קוד</p>
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
              setPin('')
              setWrong(false)
            }}
          >
            {selected.name} — החלפה
          </button>

          <div className="pin-display">
            {Array.from({ length: PIN_LENGTH }).map((_, i) => (
              <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
            ))}
          </div>
          {wrong && (
            <p className="muted" style={{ textAlign: 'center', color: 'var(--danger)' }}>
              קוד שגוי
            </p>
          )}
          {checking && (
            <p className="muted" style={{ textAlign: 'center' }}>
              בודק…
            </p>
          )}

          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} onClick={() => pressDigit(d)}>
                {d}
              </button>
            ))}
            <button className="wide" onClick={backspace}>
              ⌫
            </button>
            <button onClick={() => pressDigit('0')}>0</button>
            <button className="wide" onClick={() => setPin('')}>
              נקה
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
