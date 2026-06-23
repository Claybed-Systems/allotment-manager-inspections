/**
 * Shared header component.
 *
 * Renders the sticky top bar with optional back button, title/subtitle, and
 * the online/offline sync pill on the right.
 */

import * as sync from '../services/sync.js';
import { navigate } from '../router.js';

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
	// Always-visible build tag (right after the title). If a device is serving a
	// stale HTTP-cached copy, this shows an OLD number — instant confirmation.
	const buildTag = document.createElement('span');
	buildTag.className = 'ami-header__build';
	buildTag.textContent = 'v' + sync.BUILD;
	titleEl.appendChild(buildTag);
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
		pill._message = state.message || null;
		if (state.status === 'syncing') {
			pill.dataset.state = 'syncing';
			label.textContent = 'Syncing…';
		} else if (state.status === 'error') {
			pill.dataset.state = 'error';
			label.textContent = (queued > 0 ? s.queued.replace('%d', queued) + ' — ' : '') + 'tap';
		} else if (state.status === 'held') {
			// Photos deliberately waiting for Wi-Fi — amber, not red. Tap → queue.
			// Show the HELD photo count specifically (findings sync regardless of
			// the Wi-Fi setting, so the total queue count would overstate it).
			pill.dataset.state = 'held';
			label.textContent = (state.held || queued) + ' · Wi-Fi';
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
	// Tap the pill to open the Sync queue view — see what's waiting, retry, or
	// delete an item that the server keeps rejecting (a silent failure used to
	// leave findings "queued forever" with no way to inspect or clear them).
	pill.addEventListener('click', () => { navigate('/queue'); });

	// Tear-down hook (we don't remove the listener since the header re-renders each route)
	pill._cleanup = off;
	return pill;
}
