import { store, upsertLocalTask } from '../store';
import { updateTask } from '../utils/db';
import { auditLine, esc } from '../utils/dom';
import { code, siteLabel, statusPill } from '../ui';
import type { Task, TaskActual } from '../utils/types';

/** טיוטת טופס "השלמת משימה" — נשמרת מקומית כדי ש-realtime לא ימחק קלט שהוקלד. */
interface CompleteDraft {
  taskId: string;
  vehicle: string;
  route: string;
  reason: string;
  show: boolean;
}
let draft: CompleteDraft | null = null;

export function renderTasks(container: HTMLElement): void {
  const session = store.session!;
  const open = store.openTaskId ? store.tasks.find((t) => t.id === store.openTaskId) : null;

  if (open && open.status !== 'completed') {
    renderDetail(container, open);
    return;
  }
  store.openTaskId = null;

  // Operator: רק משימות שלו שאינן completed. Admin: כל מה שאינו completed.
  const list = store.tasks.filter((t) => {
    if (t.status === 'completed') return false;
    if (session.role === 'operator') return t.worker_id === session.id;
    return true;
  });

  container.innerHTML = `
    <section class="screen">
      <h1 class="screen-title">משימות</h1>
      ${
        list.length === 0
          ? `<div class="empty">אין משימות פעילות</div>`
          : `<div class="cards">${list.map(taskCard).join('')}</div>`
      }
    </section>`;

  container.querySelectorAll<HTMLElement>('.task-card').forEach((el) => {
    el.addEventListener('click', () => {
      store.openTaskId = el.dataset.id ?? null;
      draft = null;
      rerender();
    });
  });
}

function taskCard(t: Task): string {
  return `
    <button class="card task-card" data-id="${esc(t.id)}">
      <div class="card-top">
        ${code(t.asset_id)}
        ${statusPill(t.status)}
      </div>
      <div class="route-line">
        ${siteLabel(t.from_site_id)} <span class="arrow">←</span> ${siteLabel(t.to_site_id)}
      </div>
      <div class="card-meta">
        ${t.route ? `<span>ציר: <b>${esc(t.route)}</b></span>` : ''}
        ${t.vehicle ? `<span>רכב: <span class="code">${esc(t.vehicle)}</span></span>` : ''}
        ${t.time_window ? `<span>חלון: ${esc(t.time_window)}</span>` : ''}
      </div>
    </button>`;
}

function renderDetail(container: HTMLElement, t: Task): void {
  const body = t.status === 'planned' ? plannedBody(t) : activeBody(t);
  container.innerHTML = `
    <section class="screen">
      <button class="link-back" id="back">‹ חזרה למשימות</button>
      <div class="detail-head">
        <div class="detail-code">${code(t.asset_id)} ${statusPill(t.status)}</div>
        <div class="route-line big">
          ${siteLabel(t.from_site_id)} <span class="arrow">←</span> ${siteLabel(t.to_site_id)}
        </div>
        <div class="card-meta">
          ${t.route ? `<span>ציר מתוכנן: <b>${esc(t.route)}</b></span>` : ''}
          ${t.vehicle ? `<span>רכב מתוכנן: <span class="code">${esc(t.vehicle)}</span></span>` : ''}
          ${t.time_window ? `<span>חלון זמן: ${esc(t.time_window)}</span>` : ''}
        </div>
      </div>
      ${body}
    </section>`;

  container.querySelector('#back')?.addEventListener('click', () => {
    store.openTaskId = null;
    draft = null;
    rerender();
  });

  if (t.status === 'planned') wirePlanned(container, t);
  else wireActive(container, t);
}

// --- planned: checklist -> Start Task -------------------------------------

function plannedBody(t: Task): string {
  const allChecked = t.checklist.length > 0 && t.checklist.every((c) => c.checked);
  return `
    <div class="checklist">
      <h2 class="section-h">צ'קליסט יציאה</h2>
      ${t.checklist
        .map(
          (c, i) => `
        <label class="check-row ${c.checked ? 'checked' : ''}">
          <input type="checkbox" data-idx="${i}" ${c.checked ? 'checked' : ''} />
          <span class="check-box"></span>
          <span class="check-label">${esc(c.label)}</span>
        </label>`
        )
        .join('')}
    </div>
    <button class="btn btn-primary btn-block" id="start" ${allChecked ? '' : 'disabled'}>
      התחל משימה
    </button>
    ${allChecked ? '' : `<p class="hint">יש לסמן את כל הסעיפים כדי להתחיל</p>`}`;
}

function wirePlanned(container: HTMLElement, t: Task): void {
  container.querySelectorAll<HTMLInputElement>('.check-row input').forEach((input) => {
    input.addEventListener('change', async () => {
      const idx = Number(input.dataset.idx);
      const checklist = t.checklist.map((c, i) => (i === idx ? { ...c, checked: input.checked } : c));
      await save(t.id, { checklist });
    });
  });

  container.querySelector('#start')?.addEventListener('click', async () => {
    const audit = [...t.audit_log, auditLine('Task started')];
    await save(t.id, { status: 'active', audit_log: audit });
  });
}

// --- active: GPS + Complete Task ------------------------------------------

function activeBody(t: Task): string {
  ensureDraft(t);
  const d = draft!;
  const gps = `
    <div class="gps">
      <span class="gps-pulse"></span>
      <span class="gps-text">GPS פעיל</span>
    </div>`;

  if (!d.show) {
    return `${gps}<button class="btn btn-primary btn-block" id="open-complete">השלם משימה</button>`;
  }

  return `
    ${gps}
    <div class="complete-form">
      <h2 class="section-h">השלמת משימה — נתונים בפועל</h2>
      <label class="field">
        <span>רכב בפועל</span>
        <input type="text" id="f-vehicle" class="code-input" value="${esc(d.vehicle)}" placeholder="${esc(t.vehicle)}" />
      </label>
      <label class="field">
        <span>ציר בפועל</span>
        <input type="text" id="f-route" class="code-input" value="${esc(d.route)}" placeholder="${esc(t.route)}" />
      </label>
      <label class="field" id="reason-field" hidden>
        <span>סיבת סטייה <b class="req">*</b></span>
        <textarea id="f-reason" rows="2" placeholder="מדוע הרכב/ציר שונה מהמתוכנן?">${esc(d.reason)}</textarea>
      </label>
      <p class="deviation-note" id="dev-note" hidden>זוהתה סטייה מהמתוכנן — חובה למלא סיבה.</p>
      <div class="form-actions">
        <button class="btn" id="cancel-complete">ביטול</button>
        <button class="btn btn-primary" id="save-complete">שמור והשלם</button>
      </div>
    </div>`;
}

function ensureDraft(t: Task): void {
  if (!draft || draft.taskId !== t.id) {
    draft = { taskId: t.id, vehicle: t.vehicle, route: t.route, reason: '', show: false };
  }
}

function wireActive(container: HTMLElement, t: Task): void {
  const d = draft!;

  container.querySelector('#open-complete')?.addEventListener('click', () => {
    d.show = true;
    rerender();
  });
  container.querySelector('#cancel-complete')?.addEventListener('click', () => {
    d.show = false;
    rerender();
  });

  const vehicleEl = container.querySelector<HTMLInputElement>('#f-vehicle');
  const routeEl = container.querySelector<HTMLInputElement>('#f-route');
  const reasonEl = container.querySelector<HTMLTextAreaElement>('#f-reason');
  const reasonField = container.querySelector<HTMLElement>('#reason-field');
  const devNote = container.querySelector<HTMLElement>('#dev-note');

  const refreshDeviation = (): boolean => {
    const deviated = d.vehicle.trim() !== t.vehicle.trim() || d.route.trim() !== t.route.trim();
    if (reasonField) reasonField.hidden = !deviated;
    if (devNote) devNote.hidden = !deviated;
    return deviated;
  };

  vehicleEl?.addEventListener('input', () => {
    d.vehicle = vehicleEl.value;
    refreshDeviation();
  });
  routeEl?.addEventListener('input', () => {
    d.route = routeEl.value;
    refreshDeviation();
  });
  reasonEl?.addEventListener('input', () => {
    d.reason = reasonEl.value;
  });

  if (d.show) refreshDeviation();

  container.querySelector('#save-complete')?.addEventListener('click', async () => {
    const deviated = d.vehicle.trim() !== t.vehicle.trim() || d.route.trim() !== t.route.trim();
    if (deviated && d.reason.trim() === '') {
      if (reasonField) reasonField.hidden = false;
      if (devNote) {
        devNote.hidden = false;
        devNote.textContent = 'חובה למלא סיבת סטייה לפני שמירה.';
        devNote.classList.add('err');
      }
      reasonEl?.focus();
      return;
    }
    const actual: TaskActual = {
      vehicle: d.vehicle.trim(),
      route: d.route.trim(),
      completed_at: new Date().toISOString(),
      deviated,
      reason: deviated ? d.reason.trim() : '',
    };
    const audit = [
      ...t.audit_log,
      auditLine(deviated ? 'Task completed (deviation logged)' : 'Task completed'),
    ];
    draft = null;
    store.openTaskId = null;
    await save(t.id, { status: 'completed', actual, audit_log: audit });
  });
}

// --- shared save ----------------------------------------------------------

async function save(id: string, patch: Partial<Task>): Promise<void> {
  try {
    const updated = await updateTask(id, patch);
    upsertLocalTask(updated); // עדכון מיידי; realtime יגבה אצל שאר המשתמשים
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'שגיאה בעדכון משימה';
  }
  rerender();
}

function rerender(): void {
  window.dispatchEvent(new CustomEvent('ops:render'));
}
