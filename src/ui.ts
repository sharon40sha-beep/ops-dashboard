import { store } from './store';
import { esc } from './utils/dom';
import type { Site, TaskStatus } from './utils/types';

const KIND_HE: Record<Site['kind'], string> = {
  warehouse: 'מחסן',
  factory: 'מפעל',
  other: 'מתקן',
};

/** תווית אתר: קוד מונוספייס + סוג (מחסן/מפעל/מתקן). */
export function siteLabel(id: string): string {
  const site = store.sites.get(id);
  const kind = site ? KIND_HE[site.kind] : '';
  return `<span class="code">${esc(id)}</span>${kind ? `<span class="kind-tag">${kind}</span>` : ''}`;
}

/** רק הקוד, מונוספייס. */
export function code(id: string): string {
  return `<span class="code">${esc(id)}</span>`;
}

export const STATUS_HE: Record<TaskStatus, string> = {
  planned: 'מתוכננת',
  active: 'פעילה',
  completed: 'הושלמה',
};

export function statusPill(status: TaskStatus): string {
  return `<span class="pill pill-${status}">${STATUS_HE[status]}</span>`;
}
