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
	pill.addEventListener('click', async () => {
		// Tapping the pill shows a full status report (build + what's queued +
		// last error) then retries. A silent failure is exactly what leaves
		// findings "queued forever" with no explanation — this makes it visible.
		try {
			const d = await sync.diagnostics();
			const url = (window.amiData && window.amiData.ajaxUrl) || '(unknown)';
			let msg = 'Field Inspector build ' + d.build + '\n';
			msg += 'Saves to: ' + url + '\n\n';
			msg += 'Findings waiting: ' + d.findings.length + '\n';
			msg += 'Photos waiting: ' + d.photos.length + '\n';
			if (d.photos.length) {
				msg += 'Photo links: ' + d.photos.map((p) => '(fid=' + p.fid + ', pfid=' + p.pfid + ')').join(', ') + '\n';
			}
			if (d.lastError) {
				msg += '\nLast sync error:\n' + d.lastError + '\n';
			}
			msg += '\nTap OK to retry now.';
			window.alert(msg);
		} catch (e) { /* ignore */ }
		sync.syncOnce();
	});

	// Tear-down hook (we don't remove the listener since the header re-renders each route)
	pill._cleanup = off;
	return pill;
}
