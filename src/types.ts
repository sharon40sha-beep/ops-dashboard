export type Role = 'admin' | 'operator'
export type SiteKind = 'warehouse' | 'factory' | 'other'
export type TaskStatus = 'planned' | 'active' | 'completed'

/**
 * A public employee record — id, name and role only.
 * The PIN is NEVER sent to the client; it lives only in the DB and is checked
 * server-side by the verify_pin() RPC.
 */
export interface Employee {
  id: string
  name: string
  role: Role
}

/** Full employee row as returned by the admin_list_employees() RPC (no PIN). */
export interface AdminEmployee {
  id: string
  name: string
  role: Role
  is_active: boolean
}

/** One row from the login_attempts audit log (admin_list_login_attempts RPC). */
export interface LoginAttempt {
  id: string
  employee_id: string | null
  employee_name: string | null
  attempted_at: string
  success: boolean
  reason: string | null
}

export interface Site {
  id: string // 'S01'..'S06' warehouses, 'S07' factory, extendable
  kind: SiteKind
}

export interface Asset {
  id: string // 'A1'..'A6'
  home_site_id: string
}

export interface ChecklistItem {
  label: string
  checked: boolean
}

export interface TaskActual {
  vehicle: string
  route: string
  completed_at: string // ISO
  deviated: boolean
  reason: string
}

export interface Task {
  id: string
  asset_id: string
  from_site_id: string
  to_site_id: string
  worker_id: string
  vehicle: string
  route: string
  time_window: string
  status: TaskStatus
  checklist: ChecklistItem[]
  actual: TaskActual | null
  audit_log: string[] // e.g. "08:05 – Task created"
  created_at: string // ISO
}

/** The logged-in identity persisted in localStorage (device-local only). */
export interface Session {
  employeeId: string
  name: string
  role: Role
}
