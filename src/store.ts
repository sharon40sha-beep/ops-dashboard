import { supabase } from './utils/supabase';
import { fetchAssets, fetchSites, fetchTasks } from './utils/db';
import type { Asset, Session, Site, Task } from './utils/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

export type TabName = 'tasks' | 'create' | 'history';

interface Store {
  session: Session | null;
  sites: Map<string, Site>;
  assets: Map<string, Asset>;
  tasks: Task[];
  tab: TabName;
  /** id של המשימה שהכרטיס שלה פתוח (או null). */
  openTaskId: string | null;
  loading: boolean;
  error: string | null;
}

export const store: Store = {
  session: null,
  sites: new Map(),
  assets: new Map(),
  tasks: [],
  tab: 'tasks',
  openTaskId: null,
  loading: false,
  error: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

let channel: RealtimeChannel | null = null;

/** טוען reference data + tasks ומפעיל מנוי realtime על tasks. */
export async function initData(): Promise<void> {
  store.loading = true;
  store.error = null;
  notify();
  try {
    const [sites, assets, tasks] = await Promise.all([fetchSites(), fetchAssets(), fetchTasks()]);
    store.sites = new Map(sites.map((s) => [s.id, s]));
    store.assets = new Map(assets.map((a) => [a.id, a]));
    store.tasks = tasks;
    subscribeRealtime();
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'שגיאה בטעינת נתונים';
  } finally {
    store.loading = false;
    notify();
  }
}

/** מנוי Supabase Realtime על טבלת tasks — כל שינוי מתעדכן אצל כולם. */
function subscribeRealtime(): void {
  if (channel) return;
  channel = supabase
    .channel('tasks-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
      applyRealtimeChange(payload);
    })
    .subscribe();
}

function applyRealtimeChange(payload: {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}): void {
  if (payload.eventType === 'DELETE') {
    const oldId = (payload.old as Partial<Task>).id;
    if (oldId) store.tasks = store.tasks.filter((t) => t.id !== oldId);
  } else {
    const row = payload.new as unknown as Task;
    const idx = store.tasks.findIndex((t) => t.id === row.id);
    if (idx >= 0) store.tasks[idx] = row;
    else store.tasks.unshift(row);
    // שמירה על מיון יורד לפי created_at
    store.tasks.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  notify();
}

export function teardownRealtime(): void {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}

/** upsert מקומי מיידי אחרי כתיבה (לפני שה-event של realtime מגיע). */
export function upsertLocalTask(task: Task): void {
  const idx = store.tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) store.tasks[idx] = task;
  else store.tasks.unshift(task);
  store.tasks.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  notify();
}
