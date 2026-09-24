import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../utils/supabase'
import { PASSWORD_RULE_HINT, passwordError } from '../lib/ops'
import type { AdminEmployee, Role } from '../types'
import Toast from '../components/Toast'

type PendingKind = 'add' | 'setPin' | 'role' | 'active' | 'unlock'

interface Pending {
  kind: PendingKind
  label: string
  targetId?: string
  newRole?: Role
  newActive?: boolean
  stepUp: boolean // true -> requires re-entering the admin password
}

export default function Employees() {
  const { adminToken, setAdminToken } = useAuth()

  const [rows, setRows] = useState<AdminEmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')

  // re-auth (when there is no valid admin token, e.g. after 12h expiry)
  const [needAuth, setNeedAuth] = useState(false)
  const [authPw, setAuthPw] = useState('')
  const [authErr, setAuthErr] = useState('')
  const [authBusy, setAuthBusy] = useState(false)

  // add-employee form
  const [addName, setAddName] = useState('')
  const [addPw, setAddPw] = useState('')
  const [addRole, setAddRole] = useState<Role>('operator')

  // confirm modal
  const [pending, setPending] = useState<Pending | null>(null)
  const [newPw, setNewPw] = useState('') // for setPin
  const [stepPw, setStepPw] = useState('') // fresh password for step-up actions
  const [busy, setBusy] = useState(false)
  const [modalErr, setModalErr] = useState('')

  const load = useCallback(async () => {
    if (!adminToken) {
      setNeedAuth(true)
      setLoading(false)
      return
    }
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_employees', { session_token: adminToken })
    setLoading(false)
    if (error) {
      // token invalid / expired -> force re-auth
      setAdminToken(null)
      setNeedAuth(true)
      return
    }
    setRows((data as AdminEmployee[]) ?? [])
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
    setAdminToken(token) // triggers load() via effect
  }

  function openConfirm(p: Pending) {
    setPending(p)
    setModalErr('')
    setNewPw('')
    setStepPw('')
  }

  function closeConfirm() {
    setPending(null)
    setBusy(false)
    setModalErr('')
    setNewPw('')
    setStepPw('')
  }

  async function execute() {
    if (!pending || !adminToken) return
    setModalErr('')

    if (pending.kind === 'add') {
      if (addName.trim() === '') return setModalErr('שם עובד חובה')
      const pe = passwordError(addPw)
      if (pe) return setModalErr(pe)
    }
    if (pending.kind === 'setPin') {
      const pe = passwordError(newPw)
      if (pe) return setModalErr(pe)
    }
    if (pending.stepUp && stepPw === '') return setModalErr('נדרשת אימות סיסמה שלך')

    setBusy(true)
    let error = null as { message: string } | null
    if (pending.kind === 'role') {
      ;({ error } = await supabase.rpc('admin_set_role', {
        session_token: adminToken,
        target_id: pending.targetId,
        new_role: pending.newRole,
      }))
    } else if (pending.kind === 'active') {
      ;({ error } = await supabase.rpc('admin_set_active', {
        session_token: adminToken,
        target_id: pending.targetId,
        new_active: pending.newActive,
      }))
    } else if (pending.kind === 'setPin') {
      ;({ error } = await supabase.rpc('admin_set_pin', {
        session_token: adminToken,
        target_id: pending.targetId,
        new_pin: newPw,
      }))
    } else if (pending.kind === 'unlock') {
      ;({ error } = await supabase.rpc('admin_unlock_employee', {
        session_token: adminToken,
        actor_pin: stepPw,
        target_id: pending.targetId,
      }))
    } else if (pending.kind === 'add') {
      ;({ error } = await supabase.rpc('admin_add_employee', {
        session_token: adminToken,
        actor_pin: stepPw,
        new_name: addName.trim(),
        new_pin: addPw,
        new_role: addRole,
      }))
    }

    if (error) {
      setBusy(false)
      if (error.message.includes('session')) {
        // token expired mid-session
        setAdminToken(null)
        setNeedAuth(true)
        closeConfirm()
        return
      }
      setModalErr(translateErr(error.message))
      return
    }

    if (pending.kind === 'add') {
      setAddName('')
      setAddPw('')
      setAddRole('operator')
    }
    setBusy(false)
    setToast('בוצע')
    closeConfirm()
    void load()
  }

  // -------------------------------------------------------------------------

  if (needAuth) {
    return (
      <div>
        <div className="card">
          <h2>ניהול עובדים — אימות מנהל</h2>
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

  const addInvalid = addName.trim() === '' || passwordError(addPw) !== null

  return (
    <div>
      {/* Add employee (step-up) */}
      <div className="card">
        <h2>הוספת עובד</h2>
        <label>שם</label>
        <input type="text" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="שם העובד" />
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>סיסמה</label>
            <input type="text" value={addPw} onChange={(e) => setAddPw(e.target.value)} placeholder="סיסמה" />
          </div>
          <div style={{ flex: 1 }}>
            <label>הרשאה</label>
            <select value={addRole} onChange={(e) => setAddRole(e.target.value as Role)}>
              <option value="operator">מפעיל</option>
              <option value="admin">מנהל</option>
            </select>
          </div>
        </div>
        <p className="muted">{PASSWORD_RULE_HINT}</p>
        <button
          className="btn"
          onClick={() => openConfirm({ kind: 'add', stepUp: true, label: `הוספת עובד: ${addName.trim() || '—'}` })}
          disabled={addInvalid}
        >
          הוסף עובד
        </button>
      </div>

      {/* Roster */}
      <div className="card">
        <h2>עובדים ({rows.length})</h2>
        {rows.map((e) => (
          <div className={`emp-row ${e.is_active ? '' : 'inactive'}`} key={e.id}>
            <div className="emp-row-head">
              <div>
                <span className="emp-row-name">{e.name}</span>
                {!e.is_active && <span className="badge-off">מושבת</span>}
                {e.is_locked && <span className="badge-off">נעול</span>}
              </div>
              <select
                className="role-select"
                value={e.role}
                onChange={(ev) => {
                  const nr = ev.target.value as Role
                  if (nr !== e.role)
                    openConfirm({
                      kind: 'role',
                      targetId: e.id,
                      newRole: nr,
                      stepUp: false,
                      label: `שינוי הרשאה של ${e.name} ל-${nr === 'admin' ? 'מנהל' : 'מפעיל'}`,
                    })
                }}
              >
                <option value="operator">מפעיל</option>
                <option value="admin">מנהל</option>
              </select>
            </div>
            <div className="emp-row-actions">
              <button
                className="btn secondary sm"
                onClick={() => openConfirm({ kind: 'setPin', targetId: e.id, stepUp: false, label: `שינוי סיסמה של ${e.name}` })}
              >
                שנה סיסמה
              </button>
              {e.is_locked && (
                <button
                  className="btn sm"
                  onClick={() => openConfirm({ kind: 'unlock', targetId: e.id, stepUp: true, label: `שחרור נעילה: ${e.name}` })}
                >
                  שחרר נעילה
                </button>
              )}
              <button
                className={`btn sm ${e.is_active ? 'ghost' : ''}`}
                onClick={() =>
                  openConfirm({
                    kind: 'active',
                    targetId: e.id,
                    newActive: !e.is_active,
                    stepUp: false,
                    label: e.is_active ? `השבתת גישה: ${e.name}` : `הפעלה מחדש: ${e.name}`,
                  })
                }
              >
                {e.is_active ? 'השבת' : 'הפעל מחדש'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Confirm modal */}
      {pending && (
        <div className="modal-backdrop" onClick={() => (busy ? null : closeConfirm())}>
          <div className="modal" onClick={(ev) => ev.stopPropagation()}>
            <h2>{pending.label}</h2>

            {pending.kind === 'setPin' && (
              <>
                <label>סיסמה חדשה</label>
                <input type="text" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="סיסמה חדשה" />
                <p className="muted">{PASSWORD_RULE_HINT}</p>
              </>
            )}

            {pending.stepUp && (
              <>
                <label>אמת/י שוב את הסיסמה שלך</label>
                <input type="password" value={stepPw} onChange={(e) => setStepPw(e.target.value)} placeholder="הסיסמה שלך" />
                <p className="muted">פעולה רגישה — נדרש אימות סיסמה מחדש.</p>
              </>
            )}

            {modalErr && <div className="error-banner" style={{ marginTop: 12 }}>{modalErr}</div>}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn ghost" onClick={closeConfirm} disabled={busy}>
                ביטול
              </button>
              <button className="btn" onClick={() => void execute()} disabled={busy}>
                {busy ? 'מבצע…' : 'אישור'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast} onDone={() => setToast('')} />}
    </div>
  )
}

function translateErr(msg: string): string {
  if (msg.includes('step-up')) return 'הסיסמה שהזנת שגויה'
  if (msg.includes('session')) return 'פג תוקף החיבור — התחבר/י מחדש'
  if (msg.includes('last active admin')) return 'לא ניתן — חייב להישאר לפחות מנהל פעיל אחד'
  if (msg.includes('policy')) return 'הסיסמה אינה עומדת בדרישות (6+ תווים, אות, ספרה, סימן)'
  if (msg.includes('name is required')) return 'שם עובד חובה'
  if (msg.includes('not found')) return 'העובד לא נמצא'
  return msg
}
