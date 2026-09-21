import { store } from '../store';
import type { TabName } from '../store';

interface Tab {
  name: TabName;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { name: 'tasks', label: 'משימות', icon: '☑' },
  { name: 'create', label: 'יצירה', icon: '＋' },
  { name: 'history', label: 'היסטוריה', icon: '🕘' },
];

/** ניווט תחתון — הטאבים מסוננים לפי role. */
export function renderNav(onSelect: (tab: TabName) => void): HTMLElement {
  const isAdmin = store.session?.role === 'admin';
  const tabs = TABS.filter((t) => (t.name === 'create' ? isAdmin : true));

  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.innerHTML = tabs
    .map(
      (t) => `
      <button class="nav-btn ${store.tab === t.name ? 'active' : ''}" data-tab="${t.name}">
        <span class="nav-icon">${t.icon}</span>
        <span class="nav-label">${t.label}</span>
      </button>`
    )
    .join('');

  nav.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => onSelect(btn.dataset.tab as TabName));
  });
  return nav;
}
