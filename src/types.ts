export type Role = 'admin' | 'operator'
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
  site_type_id: string | null // -> site_types.id (managed; replaces the old fixed kind)
  is_active?: boolean
}

/** A managed site type (מחסן / מפעל / …). Replaces the old fixed SiteKind enum. */
export interface SiteType {
  id: string
  label: string
  is_active: boolean
}

/** A named gate/entry point at a site (e.g. "כניסת אבנים"). */
export interface SiteEntryPoint {
  id: string
  site_id: string
  label: string
  is_active: boolean
}

/** One ordered leg of a trip's planned route. */
export interface RouteSegment {
  sequence: number
  route_id: string | null
  checkpoint_note: string | null
}

export interface Asset {
  id: string // 'A1'..'A6'
  home_site_id: string
  is_active?: boolean
}

/** A managed checklist template. An asset may be linked to several. */
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

/** A lightweight {id,name} worker reference embedded in trips/shifts. */
export interface WorkerRef {
  id: string
  name: string
}

/** A trip = one real movement carrying one or more assets. */
export interface Trip {
  id: string
  from_site_id: string
  to_site_id: string
  worker_ids: string[]
  workers: WorkerRef[]
  vehicle_ids: string[]
  route_segments: RouteSegment[]
  planned_entry_point_id: string | null
  entry_point: string | null // label of the planned entry point (join)
  label: string | null // free display tag the admin writes (not a real detail)
  scheduled_date: string // 'YYYY-MM-DD' — REQUIRED, the planned day
  planned_start_time: string | null // 'HH:MM[:SS]' — optional guidance only
  planned_end_time: string | null
  status: TaskStatus
  return_of_trip_id: string | null
  actual: TripActual | null
  audit_log: string[]
  actual_started_at: string | null // system-stamped at Start (real click time)
  actual_completed_at: string | null // system-stamped at Complete
  created_at: string
  excluded_from_analysis?: boolean
  excluded_reason?: string | null
  items: TripItem[]
}

/** Trip "actual" (in-practice) report, stored in trips.actual (jsonb). */
export interface TripActual {
  segments: RouteSegment[]
  entry_point_id: string | null
  vehicles: string[]
  completed_at: string
  deviated: boolean
  reason: string
}

export interface LinkableTrip {
  id: string
  label: string
}

/** One minimal row in the weekly preview (list_my_week / list_week_for_employee). */
export interface WeekItem {
  id: string
  scheduled_date: string
  label: string | null
  type: 'trip' | 'duty'
  status: TaskStatus
}

// ---- duties (E) ----
export interface DutyType {
  id: string
  label: string
  template_ids: string[] // linked checklist templates (shared pool, m:n)
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
  label: string | null // free display tag the admin writes
  checklist_template_id?: string | null // the template chosen for this shift
  worker_ids: string[]
  workers: WorkerRef[]
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
  excluded_from_analysis?: boolean
  excluded_reason?: string | null
}

export interface DeletionLogEntry {
  id: string
  entity_type: string
  entity_id: string | null
  deleted_by_name: string | null
  deleted_at: string
  reason: string | null
  snapshot: Record<string, unknown> | null
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
