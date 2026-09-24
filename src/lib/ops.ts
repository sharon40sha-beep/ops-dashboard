import type { ChecklistItem, Site, SiteKind } from '../types'

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

const KIND_HE: Record<SiteKind, string> = {
  warehouse: 'מחסן',
  factory: 'מפעל',
  other: 'מתקן',
}

export function siteKindHe(kind: SiteKind | undefined): string {
  return kind ? KIND_HE[kind] : ''
}

export function siteKindOf(sites: Map<string, Site>, id: string): SiteKind | undefined {
  return sites.get(id)?.kind
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
