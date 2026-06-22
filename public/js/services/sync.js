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

// Last sync error message (surfaced in the header pill so a silent failure —
// the reason findings "stay queued forever" — is visible + reportable).
let lastError = null;
export function getLastError() { return lastError; }

// Build tag, baked into this module so the on-screen diagnostic proves at a
// glance whether the device is actually running the latest code (vs a stale
// HTTP-cached copy). Bump with the plugin version.
export const BUILD = '1.2.13';

/**
 * Full queue snapshot for the on-screen diagnostic (tap the status pill).
 * Reveals build, where writes POST, and — crucially — whether queued photos
 * are orphaned (no parent finding to attach to) vs findings that should sync.
 */
export async function diagnostics() {
	const findings = await store.allPendingFindings();
	const photos = await store.allPendingPhotos();
	return {
		build: BUILD,
		findings: findings.map((f) => ({ plot: f.plotId, round: f.roundId, rating: f.rating })),
		photos: photos.map((p) => ({ fid: p.findingId || null, pfid: p.pendingFindingId || null, file: p.filename })),
		lastError,
	};
}

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
		lastError = null;
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
					// Issue tickboxes (DB 2.11.2). Older queued rows
					// from before tickbox support don't carry the key
					// — saveFinding handles `issues === undefined` by
					// omitting the tickbox fields entirely (server
					// records NULL = "not assessed").
					issues:   f.issues,
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
				lastError = (e && e.message) ? e.message : 'Sync failed';
				console.warn('Sync: finding failed', e);
				break;
			}
		}

		const photos = await store.allPendingPhotos();
		const pendingFindingIds = new Set((await store.allPendingFindings()).map((f) => f.id));
		let orphanedPhotos = 0;
		for (const p of photos) {
			if (!p.findingId) {
				// No real finding id yet. If its pending parent is still queued
				// it's legitimately waiting; otherwise the parent is gone and
				// this photo can NEVER sync — count it as orphaned so we can
				// surface it instead of silently skipping it forever.
				if (!(p.pendingFindingId && pendingFindingIds.has(p.pendingFindingId))) {
					orphanedPhotos++;
				}
				continue;
			}
			try {
				await api.uploadPhoto({ findingId: p.findingId, blob: p.blob, filename: p.filename, caption: p.caption });
				await store.deletePendingPhoto(p.id);
				drained++;
			} catch (e) {
				lastError = (e && e.message) ? e.message : 'Photo upload failed';
				console.warn('Sync: photo failed', e);
				break;
			}
		}

		// Orphaned photos would otherwise sit "waiting" forever with no error.
		if (!lastError && orphanedPhotos > 0) {
			lastError = orphanedPhotos + ' photo(s) aren’t linked to a finding and can’t sync — open the queue and delete them, then re-take the photo on the plot.';
		}

		const remaining = await snapshot();
		const stillQueued = (remaining.findings || 0) + (remaining.photos || 0);
		const status = lastError && stillQueued > 0
			? 'error'
			: ( navigator.onLine ? 'online' : 'offline' );
		emit({ status, message: lastError, ...remaining });
		return { drained, remaining, error: lastError };
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
