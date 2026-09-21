import { fetchEmployees, verifyPin } from '../utils/db';
import { esc } from '../utils/dom';
import { saveSession } from '../utils/session';
import type { Employee } from '../utils/types';

interface LoginState {
  employees: Employee[];
  selected: Employee | null;
  pin: string;
  error: string | null;
  busy: boolean;
}

/**
 * מסך התחברות: רשימת עובדים -> בחירת שם -> הזנת PIN בן 4 ספרות -> אימות מול הטבלה.
 * onSuccess נקרא אחרי שמירת session ב-localStorage.
 */
export async function renderLogin(container: HTMLElement, onSuccess: () => void): Promise<void> {
  const state: LoginState = {
    employees: [],
    selected: null,
    pin: '',
    error: null,
    busy: false,
  };

  container.innerHTML = `<div class="login"><div class="spinner"></div><p>טוען עובדים…</p></div>`;

  try {
    state.employees = await fetchEmployees();
  } catch (err) {
    container.innerHTML = `<div class="login"><div class="login-card">
      <div class="brand">OPS</div>
      <p class="error-box">${esc(err instanceof Error ? err.message : 'שגיאה בטעינת עובדים')}</p>
      <button class="btn" id="retry">נסה שוב</button>
    </div></div>`;
    container.querySelector('#retry')?.addEventListener('click', () => renderLogin(container, onSuccess));
    return;
  }

  paint();

  function paint(): void {
    if (!state.selected) {
      container.innerHTML = `
        <div class="login">
          <div class="login-card">
            <div class="brand">OPS</div>
            <p class="login-sub">בחר עובד להתחברות</p>
            <div class="emp-list">
              ${state.employees
                .map(
                  (e) => `
                <button class="emp-btn" data-id="${esc(e.id)}">
                  <span class="emp-name">${esc(e.name)}</span>
                  <span class="role-badge role-${esc(e.role)}">${e.role === 'admin' ? 'מנהל' : 'מפעיל'}</span>
                </button>`
                )
                .join('')}
            </div>
          </div>
        </div>`;
      container.querySelectorAll<HTMLButtonElement>('.emp-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.selected = state.employees.find((e) => e.id === btn.dataset.id) ?? null;
          state.pin = '';
          state.error = null;
          paint();
        });
      });
      return;
    }

    const dots = Array.from({ length: 4 }, (_, i) => `<span class="pin-dot ${i < state.pin.length ? 'filled' : ''}"></span>`).join('');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'];
    container.innerHTML = `
      <div class="login">
        <div class="login-card">
          <button class="link-back" id="back-emp">‹ החלף עובד</button>
          <div class="pin-who">${esc(state.selected.name)}</div>
          <p class="login-sub">הזן PIN בן 4 ספרות</p>
          <div class="pin-dots">${dots}</div>
          ${state.error ? `<p class="error-box">${esc(state.error)}</p>` : ''}
          <div class="keypad">
            ${keys
              .map((k) => {
                if (k === 'back') return `<button class="key key-aux" data-k="back">⌫</button>`;
                if (k === 'ok') return `<button class="key key-ok" data-k="ok" ${state.pin.length === 4 && !state.busy ? '' : 'disabled'}>${state.busy ? '…' : '✓'}</button>`;
                return `<button class="key" data-k="${k}">${k}</button>`;
              })
              .join('')}
          </div>
        </div>
      </div>`;

    container.querySelector('#back-emp')?.addEventListener('click', () => {
      state.selected = null;
      paint();
    });

    container.querySelectorAll<HTMLButtonElement>('.key').forEach((btn) => {
      btn.addEventListener('click', () => onKey(btn.dataset.k as string));
    });
  }

  async function onKey(k: string): Promise<void> {
    if (state.busy) return;
    if (k === 'back') {
      state.pin = state.pin.slice(0, -1);
      state.error = null;
      paint();
      return;
    }
    if (k === 'ok') {
      await submit();
      return;
    }
    if (state.pin.length < 4 && /^\d$/.test(k)) {
      state.pin += k;
      state.error = null;
      paint();
      if (state.pin.length === 4) await submit();
    }
  }

  async function submit(): Promise<void> {
    if (!state.selected || state.pin.length !== 4) return;
    state.busy = true;
    state.error = null;
    paint();
    try {
      const session = await verifyPin(state.selected.id, state.pin);
      if (!session) {
        state.busy = false;
        state.pin = '';
        state.error = 'PIN שגוי';
        paint();
        return;
      }
      saveSession(session);
      onSuccess();
    } catch (err) {
      state.busy = false;
      state.pin = '';
      state.error = err instanceof Error ? err.message : 'שגיאת התחברות';
      paint();
    }
  }
}
