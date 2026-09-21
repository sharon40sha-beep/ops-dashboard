import './style.css';
import { store, subscribe, initData, teardownRealtime } from './store';
import type { TabName } from './store';
import { loadSession, clearSession } from './utils/session';
import { renderNav } from './components/nav';
import { renderLogin } from './screens/login';
import { renderTasks } from './screens/tasks';
import { renderCreate } from './screens/create';
import { renderHistory } from './screens/history';
import { esc } from './utils/dom';

const app = document.getElementById('app')!;

async function boot(): Promise<void> {
  store.session = loadSession();
  if (!store.session) {
    showLogin();
    return;
  }
  await startApp();
}

function showLogin(): void {
  teardownRealtime();
  renderLogin(app, () => {
    store.session = loadSession();
    void startApp();
  });
}

async function startApp(): Promise<void> {
  await initData();
  render();
}

/** בוחר תא לפי role ומצייר את המסך הנוכחי בתוך המעטפת. */
function render(): void {
  const session = store.session;
  if (!session) {
    showLogin();
    return;
  }

  // Operator לא רשאי להיכנס למסך יצירה
  if (store.tab === 'create' && session.role !== 'admin') store.tab = 'tasks';

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="topbar-brand">OPS</div>
        <div class="topbar-user">
          <span class="user-name">${esc(session.name)}</span>
          <span class="role-badge role-${esc(session.role)}">${session.role === 'admin' ? 'מנהל' : 'מפעיל'}</span>
          <button class="logout" id="logout" title="התנתק">⎋</button>
        </div>
      </header>
      ${store.error ? `<div class="error-banner">${esc(store.error)}</div>` : ''}
      <main class="content" id="content"></main>
    </div>`;

  const content = app.querySelector<HTMLElement>('#content')!;

  if (store.loading && store.tasks.length === 0) {
    content.innerHTML = `<div class="loading"><div class="spinner"></div><p>טוען…</p></div>`;
  } else {
    switch (store.tab) {
      case 'tasks':
        renderTasks(content);
        break;
      case 'create':
        void renderCreate(content);
        break;
      case 'history':
        renderHistory(content);
        break;
    }
  }

  app.querySelector('.shell')!.appendChild(renderNav(selectTab));
  app.querySelector('#logout')?.addEventListener('click', logout);
}

function selectTab(tab: TabName): void {
  store.tab = tab;
  store.openTaskId = null;
  store.error = null;
  render();
}

function logout(): void {
  clearSession();
  teardownRealtime();
  store.session = null;
  store.tasks = [];
  store.tab = 'tasks';
  store.openTaskId = null;
  showLogin();
}

// re-render on store changes (realtime + local writes) and on explicit signals
subscribe(() => {
  if (store.session) render();
});
window.addEventListener('ops:render', () => {
  if (store.session) render();
});

// PWA service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW optional — app works without it */
    });
  });
}

void boot();
