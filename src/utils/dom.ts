/** Escape text for safe interpolation into innerHTML. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Current wall-clock time as HH:MM (for audit-log lines). */
export function hhmm(date: Date = new Date()): string {
  return date.toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Format an ISO timestamp for display. */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** One audit-log line: "HH:MM – text". */
export function auditLine(text: string): string {
  return `${hhmm()} – ${text}`;
}
