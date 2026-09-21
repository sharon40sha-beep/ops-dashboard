import { supabase } from './supabase';
import type { Asset, Employee, Session, Site, Task } from './types';

/** רשימת עובדים למסך התחברות (בלי לחשוף PIN-ים). */
export async function fetchEmployees(): Promise<Employee[]> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, name, role')
    .order('role', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Employee[];
}

/** אימות PIN מול הטבלה — ה-PIN נשלח כפילטר, לא נקרא ל-client. */
export async function verifyPin(employeeId: string, pin: string): Promise<Session | null> {
  const { data, error } = await supabase
    .from('employees')
    .select('id, name, role')
    .eq('id', employeeId)
    .eq('pin', pin)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return data as Session;
}

export async function fetchSites(): Promise<Site[]> {
  const { data, error } = await supabase.from('sites').select('id, kind').order('id');
  if (error) throw error;
  return (data ?? []) as Site[];
}

export async function fetchAssets(): Promise<Asset[]> {
  const { data, error } = await supabase.from('assets').select('id, home_site_id').order('id');
  if (error) throw error;
  return (data ?? []) as Asset[];
}

export async function fetchTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Task[];
}

export async function insertTask(task: Partial<Task>): Promise<Task> {
  const { data, error } = await supabase.from('tasks').insert(task).select('*').single();
  if (error) throw error;
  return data as Task;
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<Task> {
  const { data, error } = await supabase
    .from('tasks')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as Task;
}
