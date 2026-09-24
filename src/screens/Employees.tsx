import { useState } from 'react'
import { supabase } from '../utils/supabase'
import { PASSWORD_RULE_HINT, passwordError } from '../lib/ops'
import type { AdminEmployee, Role } from '../types'
import Toast from '../components/Toast'

type PendingKind = 'add' | 'setPin' | 'role' | 'active'

interface Pending {
  kind: PendingKind
  label: string
  targetId?: string
  newRole?: Role
  newActive?: boolean
}

export default function Employees() {
  // actor password of the logged-in admin — kept in memory only, never persisted.
  const [gatePw, setGatePw] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [rows, setRows] = useState<AdminEmployee[]>([])
  const [loading, setLoading] = useState(false)
  const [gateErr, setGateErr] = useState('')
  const [toast, setToast] = useState('')

  // add-employee form
  const [addName, setAddName] = useState('')
  const [addPw, setAddPw] = useState('')
  const [addRole, setAddRole] = useState<Role>('operator')

  // confirm modal
  const [pending, setPending] = useState<Pending | null>(null)
  const [confirmPw, setConfirmPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [modalErr, setModalErr] = useState('')

  async function loadRoster(actorPw: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('admin_list_employees', { actor_pin: actorPw })
    if (error) return false
    setRows((data as AdminEmployee[]) ?? [])
    return true
  }

  async function unlock() {
    setGateErr('')
    setLoading(true)
    const ok = await loadRoster(gatePw)
    setLoading(false)
    if (!ok) {
      setGateErr('סיסמה שגויה או שאינה שייכת למנהל פעיל')
      return
    }
    setUnlocked(true)
  }

  function openConfirm(p: Pending) {
    setPending(p)
    setModalErr('')
    setNewPw('')
    setConfirmPw(gatePw) // prefill with the admin password already entered (editable)
  }

  function closeConfirm() {
    setPending(null)
    setBusy(false)
    setModalErr('')
    setNewPw('')
  }

  async function execute() {
    if (!pending) return
    setModalErr('')

    // client-side sanity checks (server is authoritative)
    if (pending.kind === 'add') {
      if (addName.trim() === '') return setModalErr('שם עובד חובה')
      const pe = passwordError(addPw)
      if (pe) return setModalErr(pe)
    }
    if (pending.kind === 'setPin') {
      const pe = passwordError(newPw)
      if (pe) return setModalErr(pe)
    }
    if (!confirmPw) return setModalErr('נדרשת סיסמת מנהל לאישור')

    setBusy(true)
    let error = null as { message: string } | null
    if (pending.kind === 'add') {
      ;({ error } = await supabase.rpc('admin_add_employee', {
        actor_pin: confirmPw,
        new_name: addName.trim(),
        new_pin: addPw,
        new_role: addRole,
      }))
    } else if (pending.kind === 'setPin') {
      ;({ error } = await supabase.rpc('admin_set_pin', {
        actor_pin: confirmPw,
        target_id: pending.targetId,
        new_pin: newPw,
      }))
    } else if (pending.kind === 'role') {
      ;({ error } = await supabase.rpc('admin_set_role', {
        actor_pin: confirmPw,
        target_id: pending.targetId,
        new_role: pending.newRole,
      }))
    } else if (pending.kind === 'active') {
      ;({ error } = await supabase.rpc('admin_set_active', {
        actor_pin: confirmPw,
        target_id: pending.targetId,
        new_active: pending.newActive,
      }))
    }

    if (error) {
      setBusy(false)
      setModalErr(translateErr(error.message))
      return
    }

    const ok = await loadRoster(gatePw)
    setBusy(false)
    if (pending.kind === 'add') {
      setAddName('')
      setAddPw('')
      setAddRole('operator')
    }
    setToast('בוצע')
    closeConfirm()
    if (!ok) {
      // e.g. the admin changed their own password/role — force re-auth
      setUnlocked(false)
      setGatePw('')
      setGateErr('ההרשאה השתנתה — הזן/י שוב סיסמת מנהל')
    }
  }

  // -------------------------------------------------------------------------

  if (!unlocked) {
    return (
      <div>
        <div className="card">
          <h2>ניהול עובדים — אימות מנהל</h2>
          <p className="muted">מסך זה חשוף למנהלים בלבד. הזן/י את סיסמתך כדי לטעון את הרשימה.</p>
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
          {gateErr && <div className="error-banner" style={{ marginTop: 12 }}>{gateErr}</div>}
          <button className="btn" onClick={() => void unlock()} disabled={loading || gatePw === ''}>
            {loading ? 'טוען…' : 'טען רשימה'}
          </button>
        </div>
      </div>
    )
  }

  const addInvalid = addName.trim() === '' || passwordError(addPw) !== null

  return (
    <div>
      {/* Add employee */}
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
          onClick={() => openConfirm({ kind: 'add', label: `הוספת עובד: ${addName.trim() || '—'}` })}
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
                onClick={() => openConfirm({ kind: 'setPin', targetId: e.id, label: `שינוי סיסמה של ${e.name}` })}
              >
                שנה סיסמה
              </button>
              <button
                className={`btn sm ${e.is_active ? 'ghost' : ''}`}
                onClick={() =>
                  openConfirm({
                    kind: 'active',
                    targetId: e.id,
                    newActive: !e.is_active,
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

            <label>סיסמת מנהל לאישור</label>
            <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} placeholder="סיסמה" />

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

/** Friendlier messages for the guard errors the RPCs raise. */
function translateErr(msg: string): string {
  if (msg.includes('unauthorized')) return 'סיסמת מנהל שגויה או שאינה שייכת למנהל פעיל'
  if (msg.includes('last active admin')) return 'לא ניתן — חייב להישאר לפחות מנהל פעיל אחד'
  if (msg.includes('policy')) return 'הסיסמה אינה עומדת בדרישות (6+ תווים, אות, ספרה, סימן)'
  if (msg.includes('name is required')) return 'שם עובד חובה'
  if (msg.includes('not found')) return 'העובד לא נמצא'
  return msg
}
