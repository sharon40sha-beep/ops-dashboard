import { useState } from 'react'

/**
 * A "מחק" button that opens a modal collecting a mandatory reason + the admin's
 * password (step-up), then runs the supplied delete RPC. Shows friendly errors
 * (FK "referenced by history", wrong password). Calls onDone() on success.
 */
export default function DeleteAction({
  label,
  run,
  onDone,
  small,
}: {
  label: string
  run: (reason: string, actorPin: string) => PromiseLike<{ error: { message: string } | null }>
  onDone: () => void
  small?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  function close() {
    setOpen(false); setReason(''); setPin(''); setErr(''); setBusy(false)
  }

  async function confirm() {
    setErr('')
    if (reason.trim() === '') return setErr('חובה למלא סיבת מחיקה')
    if (pin === '') return setErr('נדרשת אימות סיסמה שלך')
    setBusy(true)
    const { error } = await run(reason.trim(), pin)
    setBusy(false)
    if (error) {
      setErr(translate(error.message))
      return
    }
    close()
    onDone()
  }

  return (
    <>
      <button className={`btn danger ${small ? 'sm' : ''}`} onClick={() => setOpen(true)}>מחק</button>
      {open && (
        <div className="modal-backdrop" onClick={() => (busy ? null : close())}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>מחיקה: {label}</h2>
            <p className="muted">מחיקה היא לצמיתות ונרשמת ביומן המחיקות. לביטול השפעה זמני — עדיף ארכוב.</p>
            <label>סיבת מחיקה *</label>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="למה נמחק?" />
            <label>אמת/י שוב את הסיסמה שלך *</label>
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="הסיסמה שלך" />
            {err && <div className="error-banner" style={{ marginTop: 12 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn ghost" onClick={close} disabled={busy}>ביטול</button>
              <button className="btn danger" onClick={() => void confirm()} disabled={busy}>{busy ? 'מוחק…' : 'מחק לצמיתות'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function translate(msg: string): string {
  if (msg.includes('archive instead') || msg.includes('foreign key') || msg.includes('23503'))
    return 'לא ניתן למחוק — קיימת היסטוריה שמתייחסת לזה. השתמש/י בארכוב במקום.'
  if (msg.includes('step-up')) return 'הסיסמה שהזנת שגויה'
  if (msg.includes('session')) return 'פג תוקף החיבור — התחבר/י מחדש'
  if (msg.includes('reason required')) return 'חובה למלא סיבת מחיקה'
  if (msg.includes('not found')) return 'הפריט לא נמצא'
  return msg
}
