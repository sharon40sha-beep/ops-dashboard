import type { ChecklistItem } from './types';

/** 5 סעיפי צ'קליסט קבועים בברירת מחדל (RTL, עברית). */
export const DEFAULT_CHECKLIST_LABELS: readonly string[] = [
  'בוצעה תצפית',
  'לא זוהו חריגים',
  'סביבת היציאה נבדקה',
  'הרכב מוכן',
  'תקשורת תקינה',
];

export function buildDefaultChecklist(): ChecklistItem[] {
  return DEFAULT_CHECKLIST_LABELS.map((label) => ({ label, checked: false }));
}

/** ברירת מחדל ליעד: המפעל המשותף. */
export const DEFAULT_TO_SITE = 'S07';
