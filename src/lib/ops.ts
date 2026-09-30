import type { ChecklistItem, Site } from '../types'

// ---------------------------------------------------------------------------
// Fixed defaults
// ---------------------------------------------------------------------------

/** 5 fixed default checklist items (RTL Hebrew). */
export const DEFAULT_CHECKLIST_LABELS: readonly string[] = [
  'בוצעה תצפית',
  'לא זוהו חריגים',
  'סביבת היציאה נבדקה',
  'הרכב מוכן',
  'תקשורת תקינה',
]

export function buildDefaultChecklist(): ChecklistItem[] {
  return DEFAULT_CHECKLIST_LABELS.map((label) => ({ label, checked: false }))
}

/** Default destination: the shared factory. */
export const DEFAULT_TO_SITE = 'S07'

// ---------------------------------------------------------------------------
// Site helpers
// ---------------------------------------------------------------------------

/** Human label of a site's type (managed via site_types), '' if none/unknown. */
export function siteTypeLabel(site: Site | undefined, typesById: Map<string, string>): string {
  if (!site?.site_type_id) return ''
  return typesById.get(site.site_type_id) ?? ''
}

/** "S01 · מחסן" (or just "S01" when the type is unknown). */
export function siteLabel(site: Site | undefined, id: string, typesById: Map<string, string>): string {
  const t = siteTypeLabel(site, typesById)
  return t ? `${id} · ${t}` : id
}

// ---------------------------------------------------------------------------
// Time / audit helpers
// ---------------------------------------------------------------------------

/** Current wall-clock time as HH:MM (for audit-log lines). */
export function hhmm(date: Date = new Date()): string {
  return date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** One audit-log line: "HH:MM – text". */
export function auditLine(text: string): string {
  return `${hhmm()} – ${text}`
}

/** Format an ISO timestamp for display. */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// ---------------------------------------------------------------------------
// Password policy — MUST mirror _valid_password() in 0005_passwords.sql.
// This is a client-side reminder only; the DB is the authority.
// ---------------------------------------------------------------------------
const SYMBOL_RE = new RegExp('[!@#$%^&*()_+=.,;:?/|~<>{}]')

export const PASSWORD_RULE_HINT = 'לפחות 6 תווים, כולל אות, ספרה וסימן (!@#$%^&*…)'

/** Returns a Hebrew error string, or null if the password satisfies the policy. */
export function passwordError(pw: string): string | null {
  if (pw.length < 6) return 'הסיסמה חייבת להכיל לפחות 6 תווים'
  if (!/[A-Za-z]/.test(pw)) return 'הסיסמה חייבת להכיל לפחות אות אחת'
  if (!/[0-9]/.test(pw)) return 'הסיסמה חייבת להכיל לפחות ספרה אחת'
  if (!SYMBOL_RE.test(pw)) return 'הסיסמה חייבת להכיל לפחות סימן אחד (!@#$%^&*…)'
  return null
}

/** ISO -> value for a <input type="datetime-local"> (local wall clock). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local value -> ISO string with timezone (or null). */
export function localToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** "בעוד X דקות" from a server-computed seconds-remaining value (no client clock math). */
export function retryText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  if (s <= 60) return 'בעוד כדקה'
  const m = Math.ceil(s / 60)
  return `בעוד כ-${m} דקות`
}

/** Human-readable Hebrew reason for a login_attempts row. */
export function loginReasonHe(reason: string | null, success: boolean): string {
  if (success) return 'הצלחה'
  switch (reason) {
    case 'wrong_password':
      return 'סיסמה שגויה'
    case 'locked':
      return 'חשבון נעול'
    case 'unknown_employee':
      return 'עובד לא מזוהה'
    case 'inactive':
      return 'חשבון מושבת'
    default:
      return reason || 'כישלון'
  }
}
