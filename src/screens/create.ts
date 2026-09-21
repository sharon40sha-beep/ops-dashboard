import { store, upsertLocalTask } from '../store';
import { fetchEmployees, insertTask } from '../utils/db';
import { auditLine, esc } from '../utils/dom';
import { buildDefaultChecklist, DEFAULT_TO_SITE } from '../utils/constants';
import type { Employee, Task } from '../utils/types';

interface CreateDraft {
  assetId: string;
  fromSiteId: string;
  toSiteId: string;
  workerId: string;
  vehicle: string;
  route: string;
  timeWindow: string;
}

let workers: Employee[] | null = null;
let workersError: string | null = null;
let form: CreateDraft | null = null;
let saving = false;
let doneMsg: string | null = null;

export async function renderCreate(container: HTMLElement): Promise<void> {
  if (workers === null && workersError === null) {
    try {
      workers = await fetchEmployees();
    } catch (err) {
      workersError = err instanceof Error ? err.message : 'שגיאה בטעינת עובדים';
    }
  }

  const assets = [...store.assets.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!form) form = defaultDraft(assets[0]?.id ?? '');

  const sites = [...store.sites.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

  container.innerHTML = `
    <section class="screen">
      <h1 class="screen-title">יצירת משימה</h1>
      ${doneMsg ? `<div class="ok-box">${esc(doneMsg)}</div>` : ''}
      ${workersError ? `<div class="error-box">${esc(workersError)}</div>` : ''}

      <label class="field">
        <span>מוצר</span>
        <select id="c-asset">
          ${assets
            .map((a) => {
              const home = a.home_site_id;
              return `<option value="${esc(a.id)}" ${a.id === form!.assetId ? 'selected' : ''}>${esc(a.id)} — מחסן-בית ${esc(home)}</option>`;
            })
            .join('')}
        </select>
      </label>

      <div class="field-row">
        <label class="field">
          <span>מאתר</span>
          <select id="c-from">
            ${sites.map((s) => `<option value="${esc(s.id)}" ${s.id === form!.fromSiteId ? 'selected' : ''}>${esc(s.id)}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span>לאתר</span>
          <select id="c-to">
            ${sites.map((s) => `<option value="${esc(s.id)}" ${s.id === form!.toSiteId ? 'selected' : ''}>${esc(s.id)}</option>`).join('')}
          </select>
        </label>
      </div>

      <label class="field">
        <span>עובד מבצע</span>
        <select id="c-worker">
          <option value="">— בחר עובד —</option>
          ${(workers ?? [])
            .map((w) => `<option value="${esc(w.id)}" ${w.id === form!.workerId ? 'selected' : ''}>${esc(w.name)}${w.role === 'admin' ? ' (מנהל)' : ''}</option>`)
            .join('')}
        </select>
      </label>

      <div class="field-row">
        <label class="field">
          <span>קוד רכב</span>
          <input type="text" id="c-vehicle" class="code-input" value="${esc(form.vehicle)}" placeholder="לדוגמה V-12" />
        </label>
        <label class="field">
          <span>ציר</span>
          <input type="text" id="c-route" class="code-input" value="${esc(form.route)}" placeholder="Blue / Green / Red" />
        </label>
      </div>

      <label class="field">
        <span>חלון זמן</span>
        <input type="text" id="c-window" value="${esc(form.timeWindow)}" placeholder="לדוגמה 08:00–09:30" />
      </label>

      <button class="btn btn-primary btn-block" id="c-submit" ${saving ? 'disabled' : ''}>
        ${saving ? 'יוצר…' : 'צור משימה'}
      </button>
    </section>`;

  // --- bindings ---
  const assetEl = container.querySelector<HTMLSelectElement>('#c-asset');
  const fromEl = container.querySelector<HTMLSelectElement>('#c-from');
  const toEl = container.querySelector<HTMLSelectElement>('#c-to');
  const workerEl = container.querySelector<HTMLSelectElement>('#c-worker');
  const vehicleEl = container.querySelector<HTMLInputElement>('#c-vehicle');
  const routeEl = container.querySelector<HTMLInputElement>('#c-route');
  const windowEl = container.querySelector<HTMLInputElement>('#c-window');

  assetEl?.addEventListener('change', () => {
    form!.assetId = assetEl.value;
    // "מאתר" מתמלא אוטומטית ממחסן-הבית של המוצר (ניתן לשינוי ידני אחר-כך)
    const home = store.assets.get(assetEl.value)?.home_site_id;
    if (home) form!.fromSiteId = home;
    doneMsg = null;
    rerender();
  });
  fromEl?.addEventListener('change', () => (form!.fromSiteId = fromEl.value));
  toEl?.addEventListener('change', () => (form!.toSiteId = toEl.value));
  workerEl?.addEventListener('change', () => (form!.workerId = workerEl.value));
  vehicleEl?.addEventListener('input', () => (form!.vehicle = vehicleEl.value));
  routeEl?.addEventListener('input', () => (form!.route = routeEl.value));
  windowEl?.addEventListener('input', () => (form!.timeWindow = windowEl.value));

  container.querySelector('#c-submit')?.addEventListener('click', submit);

  async function submit(): Promise<void> {
    if (saving) return;
    if (!form!.assetId || !form!.fromSiteId || !form!.toSiteId) {
      workersError = 'יש לבחור מוצר, מאתר ולאתר';
      rerender();
      return;
    }
    if (!form!.workerId) {
      workersError = 'יש לבחור עובד מבצע';
      rerender();
      return;
    }
    saving = true;
    workersError = null;
    doneMsg = null;
    rerender();
    try {
      const newTask: Partial<Task> = {
        asset_id: form!.assetId,
        from_site_id: form!.fromSiteId,
        to_site_id: form!.toSiteId,
        worker_id: form!.workerId,
        vehicle: form!.vehicle.trim(),
        route: form!.route.trim(),
        time_window: form!.timeWindow.trim(),
        status: 'planned',
        checklist: buildDefaultChecklist(),
        actual: null,
        audit_log: [auditLine('Task created')],
      };
      const created = await insertTask(newTask);
      upsertLocalTask(created);
      doneMsg = `נוצרה משימה למוצר ${created.asset_id} (${created.from_site_id} ← ${created.to_site_id})`;
      form = defaultDraft(form!.assetId);
    } catch (err) {
      workersError = err instanceof Error ? err.message : 'שגיאה ביצירת משימה';
    } finally {
      saving = false;
      rerender();
    }
  }
}

function defaultDraft(assetId: string): CreateDraft {
  const home = assetId ? store.assets.get(assetId)?.home_site_id ?? '' : '';
  return {
    assetId,
    fromSiteId: home,
    toSiteId: store.sites.has(DEFAULT_TO_SITE) ? DEFAULT_TO_SITE : '',
    workerId: '',
    vehicle: '',
    route: '',
    timeWindow: '',
  };
}

function rerender(): void {
  window.dispatchEvent(new CustomEvent('ops:render'));
}
