/**
 * Sync queue: drains pending_findings and pending_photos when online.
 *
 * Flow:
 *   1. For each pending finding: POST to am_inspection_record_finding.
 *      On success: store returned finding_id, reassign queued photos to it,
 *      delete the pending_finding record.
 *   2. For each pending photo with findingId set: upload via
 *      am_inspection_upload_photo, then delete the queued row.
 *
 * Triggered on:
 *   - App boot, if navigator.onLine
 *   - window 'online' event
 *   - Manual call after the user submits a finding while online
 *
 * Concurrency: a single in-flight drain at a time, protected by a promise lock.
 */

import * as store from './store.js';
import * as api from './api.js';

let inFlight = null;

const listeners = new Set();

export function onSyncChange(cb) {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

function emit(state) {
	listeners.forEach((cb) => {
		try { cb(state); } catch (e) { /* swallow */ }
	});
}

export async function snapshot() {
	const findings = await store.allPendingFindings();
	const photos = await store.allPendingPhotos();
	return { findings: findings.length, photos: photos.length };
}

export async function syncOnce() {
	if (!navigator.onLine) return { drained: 0, remaining: await snapshot() };
	if (inFlight) return inFlight;
	inFlight = (async () => {
		emit({ status: 'syncing', ...(await snapshot()) });
		let drained = 0;

		const findings = await store.allPendingFindings();
		for (const f of findings) {
			try {
				const result = await api.saveFinding({
					roundId:  f.roundId,
					plotId:   f.plotId,
					memberId: f.memberId,
					rating:   f.rating,
					notes:    f.notes,
				});
				const newFindingId = result && (result.finding_id || result.id);
				if (newFindingId) {
					await store.reassignPhotosToFinding(f.id, newFindingId);
				}
				await store.deletePendingFinding(f.id);
				drained++;
			} catch (e) {
				// Stop draining findings if the server is reachable but rejected.
				// Photos for this finding stay queued tagged with pendingFindingId.
				console.warn('Sync: finding failed', e);
				break;
			}
		}

		const photos = await store.allPendingPhotos();
		for (const p of photos) {
			if (!p.findingId) continue; // wait until its parent finding lands
			try {
				await api.uploadPhoto({ findingId: p.findingId, blob: p.blob, filename: p.filename, caption: p.caption });
				await store.deletePendingPhoto(p.id);
				drained++;
			} catch (e) {
				console.warn('Sync: photo failed', e);
				break;
			}
		}

		const remaining = await snapshot();
		emit({ status: navigator.onLine ? 'online' : 'offline', ...remaining });
		return { drained, remaining };
	})().finally(() => { inFlight = null; });
	return inFlight;
}

export function startAutoSync() {
	// Emit initial state.
	(async () => {
		emit({ status: navigator.onLine ? 'online' : 'offline', ...(await snapshot()) });
	})();

	window.addEventListener('online', () => { syncOnce(); });
	window.addEventListener('offline', async () => {
		emit({ status: 'offline', ...(await snapshot()) });
	});

	// Try once at boot.
	if (navigator.onLine) syncOnce();

	// Gentle poll every 60 s as a backstop.
	setInterval(() => { if (navigator.onLine) syncOnce(); }, 60_000);
}
