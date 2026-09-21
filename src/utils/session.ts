import type { Session } from './types';

const KEY = 'ops.session';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (parsed && parsed.id && parsed.name && parsed.role) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* private mode / storage disabled — session simply won't persist */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
