import { store } from '../store';
import { esc, fmtDateTime } from '../utils/dom';
import { code, siteLabel } from '../ui';
import type { Task } from '../utils/types';

/** ids של משימות שה-audit-log שלהן פתוח כרגע. */
const openLogs = new Set<string>();

export function renderHistory(container: HTMLElement): void {
  const session = store.session!;
  const completed = store.tasks.filter((t) => {
    if (t.status !== 'completed') return false;
    if (session.role === 'operator') return t.worker_id === session.id;
    return true;
  });

  container.innerHTML = `
    <section class="screen">
      <h1 class="screen-title">היסטוריה</h1>
      ${
        completed.length === 0
          ? `<div class="empty">אין משימות שהושלמו</div>`
          : `<div class="cards">${completed.map(historyCard).join('')}</div>`
      }
    </section>`;

  container.querySelectorAll<HTMLElement>('.log-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id!;
      if (openLogs.has(id)) openLogs.delete(id);
      else openLogs.add(id);
      window.dispatchEvent(new CustomEvent('ops:render'));
    });
  });
}

function historyCard(t: Task): string {
  const a = t.actual;
  const vehicleDiff = a ? a.vehicle.trim() !== t.vehicle.trim() : false;
  const routeDiff = a ? a.route.trim() !== t.route.trim() : false;
  const logOpen = openLogs.has(t.id);

  return `
    <div class="card history-card">
      <div class="card-top">
        ${code(t.asset_id)}
        <span class="hist-when">${a?.completed_at ? fmtDateTime(a.completed_at) : ''}</span>
      </div>
      <div class="route-line">
        ${siteLabel(t.from_site_id)} <span class="arrow">←</span> ${siteLabel(t.to_site_id)}
      </div>

      <div class="pa-grid">
        <div class="pa-head">מתוכנן</div>
        <div class="pa-head">בפועל</div>

        <div class="pa-cell">רכב: <span class="code">${esc(t.vehicle || '—')}</span></div>
        <div class="pa-cell ${vehicleDiff ? 'diff' : ''}">רכב: <span class="code">${esc(a?.vehicle || '—')}</span></div>

        <div class="pa-cell">ציר: <b>${esc(t.route || '—')}</b></div>
        <div class="pa-cell ${routeDiff ? 'diff' : ''}">ציר: <b>${esc(a?.route || '—')}</b></div>
      </div>

      ${
        a?.deviated
          ? `<div class="reason-box"><b>סיבת סטייה:</b> ${esc(a.reason || '—')}</div>`
          : ''
      }

      <button class="log-toggle" data-id="${esc(t.id)}">
        ${logOpen ? '▾' : '▸'} audit log (${t.audit_log.length})
      </button>
      ${
        logOpen
          ? `<ul class="audit-log">${t.audit_log.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
          : ''
      }
    </div>`;
}
