/**
 * Shared header component.
 *
 * Renders the sticky top bar with optional back button, title/subtitle, and
 * the online/offline sync pill on the right.
 */

import * as sync from '../services/sync.js';

const s = window.amiData.strings;

export function renderHeader({ title, subtitle = '', showBack = false, onBack = null } = {}) {
	const header = document.createElement('header');
	header.className = 'ami-header';

	if (showBack) {
		const back = document.createElement('button');
		back.type = 'button';
		back.className = 'ami-header__back';
		back.setAttribute('aria-label', s.back);
		back.innerHTML = '←';
		back.onclick = () => {
			if (typeof onBack === 'function') onBack();
			else if (window.history.length > 1) window.history.back();
			else window.location.hash = '#/';
		};
		header.appendChild(back);
	}

	const titleEl = document.createElement('h1');
	titleEl.className = 'ami-header__title';
	titleEl.textContent = title || '';
	if (subtitle) {
		const sub = document.createElement('span');
		sub.className = 'ami-header__sub';
		sub.textContent = subtitle;
		titleEl.appendChild(sub);
	}
	header.appendChild(titleEl);

	const pill = renderSyncPill();
	header.appendChild(pill);

	return header;
}

function renderSyncPill() {
	const pill = document.createElement('button');
	pill.type = 'button';
	pill.className = 'ami-header__pill';
	pill.dataset.state = navigator.onLine ? 'online' : 'offline';

	const dot = document.createElement('span');
	dot.className = 'ami-header__pill__dot';
	pill.appendChild(dot);

	const label = document.createElement('span');
	label.className = 'ami-header__pill__label';
	pill.appendChild(label);

	const update = (state) => {
		const queued = (state.findings || 0) + (state.photos || 0);
		if (state.status === 'syncing') {
			pill.dataset.state = 'syncing';
			label.textContent = 'Syncing…';
		} else if (queued > 0) {
			pill.dataset.state = 'offline';
			label.textContent = s.queued.replace('%d', queued);
		} else {
			pill.dataset.state = navigator.onLine ? 'online' : 'offline';
			label.textContent = navigator.onLine ? s.online : s.offline;
		}
	};

	sync.snapshot().then((snap) => update({ status: navigator.onLine ? 'online' : 'offline', ...snap }));

	const off = sync.onSyncChange(update);
	pill.addEventListener('click', () => { sync.syncOnce(); });

	// Tear-down hook (we don't remove the listener since the header re-renders each route)
	pill._cleanup = off;
	return pill;
}
