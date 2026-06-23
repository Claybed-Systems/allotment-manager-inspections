/**
 * Sync queue view (#/queue).
 *
 * Lets the inspector see exactly what is waiting to sync and delete any item
 * that is blocking the queue (e.g. a finding the server keeps rejecting). Also
 * shows the build, where it saves to, and the last sync error, and offers a
 * manual retry. Reached by tapping the status pill in the header.
 */

import { renderHeader } from '../components/header.js';
import * as store from '../services/store.js';
import * as sync from '../services/sync.js';
import * as net from '../services/net.js';

function escapeHtml(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}

export async function render(_params, { mount, navigate }) {
	mount.innerHTML = '';
	mount.appendChild(renderHeader({ title: 'Sync queue', showBack: true, onBack: () => navigate('/') }));

	const main = document.createElement('main');
	main.className = 'ami-main ami-queue';
	mount.appendChild(main);

	async function draw() {
		main.innerHTML = '';

		const findings = await store.allPendingFindings();
		const photos = await store.allPendingPhotos();

		// Info line: build + where saves go.
		const info = document.createElement('div');
		info.className = 'ami-queue-info';
		const url = (window.amiData && window.amiData.ajaxUrl) || '(unknown)';
		info.innerHTML = 'Build <strong>v' + escapeHtml(sync.BUILD) + '</strong><br>Saves to: ' + escapeHtml(url);
		main.appendChild(info);

		// Photo-upload settings (Wi-Fi only + manual "upload now").
		main.appendChild(photoSettings(photos.length));

		// Last sync error, if any.
		const err = sync.getLastError && sync.getLastError();
		if (err) {
			const e = document.createElement('div');
			e.className = 'ami-error';
			e.textContent = 'Last sync error: ' + err;
			main.appendChild(e);
		}

		// Retry button.
		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'ami-btn';
		retry.textContent = 'Retry sync now';
		retry.onclick = async () => {
			retry.disabled = true;
			retry.textContent = 'Syncing…';
			await sync.syncOnce();
			draw();
		};
		main.appendChild(retry);

		if (!findings.length && !photos.length) {
			const empty = document.createElement('div');
			empty.className = 'ami-empty';
			empty.textContent = 'Nothing is waiting to sync.';
			main.appendChild(empty);
			return;
		}

		if (findings.length) {
			const h = document.createElement('label');
			h.className = 'ami-label';
			h.textContent = 'Findings waiting (' + findings.length + ')';
			main.appendChild(h);
			for (const f of findings) {
				main.appendChild(row(
					'Plot #' + f.plotId + ' · rating ' + f.rating,
					f.notes ? f.notes : '(no notes — a summary is filled in automatically)',
					async () => { await store.deletePendingFinding(f.id); draw(); }
				));
			}
		}

		if (photos.length) {
			const pendingIds = new Set(findings.map((f) => f.id));
			const h = document.createElement('label');
			h.className = 'ami-label';
			h.textContent = 'Photos waiting (' + photos.length + ')';
			main.appendChild(h);
			for (const p of photos) {
				let parent;
				if (p.findingId) {
					parent = 'attached to finding ' + p.findingId;
				} else if (p.pendingFindingId && pendingIds.has(p.pendingFindingId)) {
					parent = 'waiting for its finding to save first';
				} else {
					parent = '⚠ not linked to a finding — delete it, then re-take the photo';
				}
				main.appendChild(row(p.filename || 'photo', parent, async () => { await store.deletePendingPhoto(p.id); draw(); }));
			}
		}
	}

	// "Photo uploads" settings: the Wi-Fi-only toggle + a manual force-upload.
	// Photos always queue and upload in the background; this controls WHEN the
	// background loop is allowed to spend mobile data on them. Findings (tiny)
	// always sync regardless.
	function photoSettings(photoCount) {
		const box = document.createElement('div');
		box.className = 'ami-photo-settings';

		const h = document.createElement('label');
		h.className = 'ami-label';
		h.textContent = 'Photo uploads';
		box.appendChild(h);

		const toggle = document.createElement('label');
		toggle.className = 'ami-issue';
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.checked = net.isWifiOnly();
		cb.addEventListener('change', () => {
			net.setWifiOnly(cb.checked);
			// Turning it OFF may release photos that were waiting for Wi-Fi.
			if (!cb.checked) sync.syncOnce();
			draw();
		});
		const txt = document.createElement('span');
		txt.textContent = 'Upload photos on Wi-Fi only';
		toggle.append(cb, txt);
		box.appendChild(toggle);

		const hint = document.createElement('div');
		hint.className = 'ami-queue-hint';
		if (!net.isWifiOnly()) {
			hint.textContent = 'Photos upload in the background whenever you’re online.';
		} else if (net.canDetectConnection()) {
			hint.textContent = 'Photos upload only on Wi-Fi (this device is ' + net.describeConnection()
				+ '). Findings still sync on mobile data.';
		} else {
			hint.textContent = 'This device can’t tell Wi-Fi from mobile data, so photos are held until you '
				+ 'tap “Upload photos now”. Findings still sync on mobile data.';
		}
		box.appendChild(hint);

		// Manual override — upload queued photos now regardless of the setting
		// (how an iPhone inspector releases held photos once on Wi-Fi).
		if (photoCount > 0) {
			const force = document.createElement('button');
			force.type = 'button';
			force.className = 'ami-btn ami-btn--secondary';
			force.textContent = 'Upload photos now';
			force.onclick = async () => {
				force.disabled = true;
				force.textContent = 'Uploading…';
				await sync.syncOnce({ forcePhotos: true });
				draw();
			};
			box.appendChild(force);
		}

		return box;
	}

	function row(title, sub, onDelete) {
		const el = document.createElement('div');
		el.className = 'ami-queue-row';
		const txt = document.createElement('div');
		txt.className = 'ami-queue-row__text';
		txt.innerHTML = '<strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(sub) + '</span>';
		el.appendChild(txt);
		const del = document.createElement('button');
		del.type = 'button';
		del.className = 'ami-queue-row__del';
		del.textContent = 'Delete';
		del.onclick = async () => {
			if (!window.confirm('Remove this from the queue? It will NOT be saved to the server.')) return;
			await onDelete();
		};
		el.appendChild(del);
		return el;
	}

	await draw();

	// Keep the queue live: redraw when the QUEUE CONTENTS change — background
	// uploads draining, or photos released after turning Wi-Fi-only off — so the
	// list and the "Upload photos now" button reflect reality without a manual
	// retry. Guard on the finding/photo counts so the transient 'syncing' emit
	// (which carries the same pre-drain counts) doesn't tear down and rebuild the
	// page mid-interaction. The router invokes the returned cleanup on navigate.
	let lastCounts = null;
	const off = sync.onSyncChange((state) => {
		const counts = (state.findings ?? -1) + ':' + (state.photos ?? -1);
		if (counts === lastCounts) return;
		lastCounts = counts;
		draw();
	});
	return () => { if (off) off(); };
}
