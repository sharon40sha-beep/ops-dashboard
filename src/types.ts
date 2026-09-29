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
  is_locked: boolean
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
  is_active?: boolean
}

export interface Asset {
  id: string // 'A1'..'A6'
  home_site_id: string
  is_active?: boolean
  checklist_template_id?: string | null
}

/** A managed checklist template (one per asset). */
export interface ChecklistTemplate {
  id: string
  name: string
  is_active: boolean
}

/** One asset inside a trip, with its own copied checklist. */
export interface TripItem {
  id: string
  trip_id: string
  asset_id: string
  checklist: ChecklistItem[]
  checklist_note: string | null
}

/** A trip = one real movement carrying one or more assets. */
export interface Trip {
  id: string
  from_site_id: string
  to_site_id: string
  worker_id: string
  vehicle_id: string | null
  route_id: string | null
  time_window: string
  status: TaskStatus
  return_of_trip_id: string | null
  actual: TaskActual | null
  audit_log: string[]
  started_at: string | null
  created_at: string
  items: TripItem[]
}

export interface LinkableTrip {
  id: string
  label: string
}

// ---- duties (E) ----
export interface DutyType {
  id: string
  label: string
  checklist_template_id: string | null
  is_active: boolean
}

export interface DutyActual {
  actual_start: string | null
  actual_end: string | null
  anomaly_found: boolean
  anomaly_notes: string
  completed_at?: string
}

export interface DutyShift {
  id: string
  site_id: string
  worker_id: string
  duty_type_id: string
  duty_type_label: string
  start_time: string
  end_time: string
  status: TaskStatus
  checklist: ChecklistItem[]
  checklist_note: string | null
  actual: DutyActual | null
  audit_log: string[]
  created_at: string
}

// ---- analytics (D) ----
export interface JointPair {
  a: string
  b: string
  joint: number
  total_a: number
  total_b: number
  pct_a: number
  pct_b: number
}

export interface DutySummary {
  total: number
  anomalies: number
  by_type: { key: string; count: number }[]
  by_worker: { key: string; count: number }[]
}

export interface Route {
  id: string
  is_active: boolean
}

export interface Vehicle {
  id: string
  is_active: boolean
}

export interface ChecklistItem {
  label: string
  checked: boolean
  critical?: boolean
}

/** Managed checklist template row (admin content management). */
export interface ChecklistTemplateItem {
  id: string
  label: string
  critical: boolean
  sort_order: number
  is_active: boolean
}

/** Result of admin_asset_summary(). */
export interface AssetSummary {
  total: number
  deviated: number
  hours: { hour: number; count: number }[]
  by_vehicle: { key: string; count: number }[]
  by_route: { key: string; count: number }[]
  by_worker: { key: string; count: number }[]
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
