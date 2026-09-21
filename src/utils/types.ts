export type Role = 'admin' | 'operator';
export type SiteKind = 'warehouse' | 'factory' | 'other';
export type TaskStatus = 'planned' | 'active' | 'completed';

export interface Employee {
  id: string;
  name: string;
  role: Role;
}

export interface Site {
  id: string;
  kind: SiteKind;
}

export interface Asset {
  id: string;
  home_site_id: string;
}

export interface ChecklistItem {
  label: string;
  checked: boolean;
}

export interface TaskActual {
  vehicle: string;
  route: string;
  completed_at: string;
  deviated: boolean;
  reason: string;
}

export interface Task {
  id: string;
  asset_id: string;
  from_site_id: string;
  to_site_id: string;
  worker_id: string;
  vehicle: string;
  route: string;
  time_window: string;
  status: TaskStatus;
  checklist: ChecklistItem[];
  actual: TaskActual | null;
  audit_log: string[];
  created_at: string;
}

/** Session stored in localStorage after PIN login (no Supabase Auth). */
export interface Session {
  id: string;
  name: string;
  role: Role;
}
