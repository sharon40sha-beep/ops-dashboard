import { useState } from 'react'
import { supabase } from '../utils/supabase'
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
  // actor PIN of the logged-in admin — kept in memory only, never persisted.
  const [gatePin, setGatePin] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [rows, setRows] = useState<AdminEmployee[]>([])
  const [loading, setLoading] = useState(false)
  const [gateErr, setGateErr] = useState('')
  const [toast, setToast] = useState('')

  // add-employee form
  const [addName, setAddName] = useState('')
  const [addPin, setAddPin] = useState('')
  const [addRole, setAddRole] = useState<Role>('operator')

  // confirm modal
  const [pending, setPending] = useState<Pending | null>(null)
  const [confirmPin, setConfirmPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [modalErr, setModalErr] = useState('')

  async function loadRoster(actorPin: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('admin_list_employees', { actor_pin: actorPin })
    if (error) return false
    setRows((data as AdminEmployee[]) ?? [])
    return true
  }

  async function unlock() {
    setGateErr('')
    setLoading(true)
    const ok = await loadRoster(gatePin)
    setLoading(false)
    if (!ok) {
      setGateErr('PIN שגוי או שאינו שייך למנהל פעיל')
      return
    }
    setUnlocked(true)
  }

  function openConfirm(p: Pending) {
    setPending(p)
    setModalErr('')
    setNewPin('')
    setConfirmPin(gatePin) // prefill with the admin PIN already entered (editable)
  }

  function closeConfirm() {
    setPending(null)
    setBusy(false)
    setModalErr('')
    setNewPin('')
  }

  async function execute() {
    if (!pending) return
    setModalErr('')

    // client-side sanity checks before hitting the RPC
    if (pending.kind === 'add') {
      if (addName.trim() === '') return setModalErr('שם עובד חובה')
      if (!/^\d{4}$/.test(addPin)) return setModalErr('PIN חייב להיות 4 ספרות')
    }
    if (pending.kind === 'setPin' && !/^\d{4}$/.test(newPin)) {
      return setModalErr('PIN חדש חייב להיות 4 ספרות')
    }
    if (!confirmPin) return setModalErr('נדרש PIN מנהל לאישור')

    setBusy(true)
    let error = null as { message: string } | null
    if (pending.kind === 'add') {
      ;({ error } = await supabase.rpc('admin_add_employee', {
        actor_pin: confirmPin,
        new_name: addName.trim(),
        new_pin: addPin,
        new_role: addRole,
      }))
    } else if (pending.kind === 'setPin') {
      ;({ error } = await supabase.rpc('admin_set_pin', {
        actor_pin: confirmPin,
        target_id: pending.targetId,
        new_pin: newPin,
      }))
    } else if (pending.kind === 'role') {
      ;({ error } = await supabase.rpc('admin_set_role', {
        actor_pin: confirmPin,
        target_id: pending.targetId,
        new_role: pending.newRole,
      }))
    } else if (pending.kind === 'active') {
      ;({ error } = await supabase.rpc('admin_set_active', {
        actor_pin: confirmPin,
        target_id: pending.targetId,
        new_active: pending.newActive,
      }))
    }

    if (error) {
      setBusy(false)
      setModalErr(translateErr(error.message))
      return
    }

    // success — reload roster (use the same admin PIN gate)
    const ok = await loadRoster(gatePin)
    setBusy(false)
    if (pending.kind === 'add') {
      setAddName('')
      setAddPin('')
      setAddRole('operator')
    }
    setToast('בוצע')
    closeConfirm()
    if (!ok) {
      // e.g. the admin changed their own PIN/role — force re-auth into the screen
      setUnlocked(false)
      setGatePin('')
      setGateErr('ההרשאה השתנתה — הזן שוב PIN מנהל')
    }
  }

  // -------------------------------------------------------------------------

  if (!unlocked) {
    return (
      <div>
        <div className="card">
          <h2>ניהול עובדים — אימות מנהל</h2>
          <p className="muted">מסך זה חשוף למנהלים בלבד. הזן/י את ה-PIN שלך כדי לטעון את הרשימה.</p>
          <label>PIN מנהל</label>
          <input
            type="password"
            inputMode="numeric"
            maxLength={4}
            className="mono"
            value={gatePin}
            onChange={(e) => setGatePin(e.target.value.replace(/\D/g, ''))}
            placeholder="••••"
          />
          {gateErr && <div className="error-banner" style={{ marginTop: 12 }}>{gateErr}</div>}
          <button className="btn" onClick={() => void unlock()} disabled={loading || gatePin.length !== 4}>
            {loading ? 'טוען…' : 'טען רשימה'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Add employee */}
      <div className="card">
        <h2>הוספת עובד</h2>
        <label>שם</label>
        <input type="text" value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="שם העובד" />
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label>PIN (4 ספרות)</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              className="mono"
              value={addPin}
              onChange={(e) => setAddPin(e.target.value.replace(/\D/g, ''))}
              placeholder="1234"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>הרשאה</label>
            <select value={addRole} onChange={(e) => setAddRole(e.target.value as Role)}>
              <option value="operator">מפעיל</option>
              <option value="admin">מנהל</option>
            </select>
          </div>
        </div>
        <button
          className="btn"
          onClick={() => openConfirm({ kind: 'add', label: `הוספת עובד: ${addName.trim() || '—'}` })}
          disabled={addName.trim() === '' || addPin.length !== 4}
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
                onClick={() => openConfirm({ kind: 'setPin', targetId: e.id, label: `שינוי PIN של ${e.name}` })}
              >
                שנה PIN
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
                <label>PIN חדש (4 ספרות)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  className="mono"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="1234"
                />
              </>
            )}

            <label>PIN מנהל לאישור</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              className="mono"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
              placeholder="••••"
            />

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
  if (msg.includes('unauthorized')) return 'PIN מנהל שגוי או שאינו שייך למנהל פעיל'
  if (msg.includes('last active admin')) return 'לא ניתן — חייב להישאר לפחות מנהל פעיל אחד'
  if (msg.includes('4 digits')) return 'PIN חייב להיות 4 ספרות'
  if (msg.includes('name is required')) return 'שם עובד חובה'
  if (msg.includes('not found')) return 'העובד לא נמצא'
  return msg
}
