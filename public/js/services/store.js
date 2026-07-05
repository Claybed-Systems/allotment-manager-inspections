/**
 * Lightweight IndexedDB wrapper.
 *
 * Three object stores:
 *   - pending_findings:  queued finding saves (we are offline / save failed)
 *   - pending_photos:    queued photo uploads (separate so we can retry independently)
 *   - cache:             generic GET-response cache (rounds list, plot list, etc.)
 *
 * Keys for pending_* are auto-generated timestamps + random suffix for uniqueness.
 */

const DB_NAME = 'ami-inspector';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains('pending_findings')) {
				db.createObjectStore('pending_findings', { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains('pending_photos')) {
				const ps = db.createObjectStore('pending_photos', { keyPath: 'id' });
				ps.createIndex('pendingFindingId', 'pendingFindingId', { unique: false });
				ps.createIndex('findingId', 'findingId', { unique: false });
			}
			if (!db.objectStoreNames.contains('cache')) {
				db.createObjectStore('cache', { keyPath: 'key' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

function tx(storeNames, mode = 'readonly') {
	return openDb().then((db) => db.transaction(storeNames, mode));
}

function uid() {
	return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ---- Pending findings ----

export async function queueFinding(record) {
	const id = uid();
	const t = await tx(['pending_findings'], 'readwrite');
	const store = t.objectStore('pending_findings');
	const row = { id, ...record, queuedAt: Date.now() };
	return new Promise((resolve, reject) => {
		const req = store.put(row);
		req.onsuccess = () => resolve(row);
		req.onerror = () => reject(req.error);
	});
}

export async function allPendingFindings() {
	const t = await tx(['pending_findings']);
	return new Promise((resolve, reject) => {
		const req = t.objectStore('pending_findings').getAll();
		req.onsuccess = () => resolve(req.result || []);
		req.onerror = () => reject(req.error);
	});
}

/**
 * Annotate a queued finding with the reason the server permanently rejected it
 * (HTTP 400 — e.g. the inspector's own plot, a duplicate, a vacant plot). The
 * row is KEPT (nothing is lost); the queue view reads `lastRejection` to show
 * which item is stuck and why. No-op if the row was drained in the meantime.
 */
export async function markFindingRejected(id, message) {
	const t = await tx(['pending_findings'], 'readwrite');
	const os = t.objectStore('pending_findings');
	return new Promise((resolve, reject) => {
		const g = os.get(id);
		g.onsuccess = () => {
			const row = g.result;
			if (!row) return resolve(false);
			row.lastRejection = message || 'Rejected';
			row.rejectedAt = Date.now();
			const p = os.put(row);
			p.onsuccess = () => resolve(true);
			p.onerror = () => reject(p.error);
		};
		g.onerror = () => reject(g.error);
	});
}

export async function deletePendingFinding(id) {
	const t = await tx(['pending_findings'], 'readwrite');
	return new Promise((resolve, reject) => {
		const req = t.objectStore('pending_findings').delete(id);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

// ---- Pending photos ----

export async function queuePhoto({ pendingFindingId, findingId, blob, filename, caption }) {
	const id = uid();
	const t = await tx(['pending_photos'], 'readwrite');
	const store = t.objectStore('pending_photos');
	const row = { id, pendingFindingId: pendingFindingId || null, findingId: findingId || null, blob, filename, caption: caption || '', queuedAt: Date.now() };
	return new Promise((resolve, reject) => {
		const req = store.put(row);
		req.onsuccess = () => resolve(row);
		req.onerror = () => reject(req.error);
	});
}

export async function allPendingPhotos() {
	const t = await tx(['pending_photos']);
	return new Promise((resolve, reject) => {
		const req = t.objectStore('pending_photos').getAll();
		req.onsuccess = () => resolve(req.result || []);
		req.onerror = () => reject(req.error);
	});
}

export async function pendingPhotosForFinding(pendingFindingId) {
	const t = await tx(['pending_photos']);
	const idx = t.objectStore('pending_photos').index('pendingFindingId');
	return new Promise((resolve, reject) => {
		const req = idx.getAll(pendingFindingId);
		req.onsuccess = () => resolve(req.result || []);
		req.onerror = () => reject(req.error);
	});
}

export async function deletePendingPhoto(id) {
	const t = await tx(['pending_photos'], 'readwrite');
	return new Promise((resolve, reject) => {
		const req = t.objectStore('pending_photos').delete(id);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

export async function reassignPhotosToFinding(pendingFindingId, findingId) {
	const t = await tx(['pending_photos'], 'readwrite');
	const idx = t.objectStore('pending_photos').index('pendingFindingId');
	const req = idx.getAll(pendingFindingId);
	return new Promise((resolve, reject) => {
		req.onsuccess = () => {
			const rows = req.result || [];
			const store = t.objectStore('pending_photos');
			rows.forEach((r) => { r.findingId = findingId; r.pendingFindingId = null; store.put(r); });
			t.oncomplete = () => resolve(rows.length);
		};
		req.onerror = () => reject(req.error);
	});
}

export async function pendingCount() {
	const findings = await allPendingFindings();
	const photos = await allPendingPhotos();
	return findings.length + photos.length;
}

// ---- Cache ----

export async function cacheSet(key, value, ttlMs = 5 * 60 * 1000) {
	const t = await tx(['cache'], 'readwrite');
	const row = { key, value, expiresAt: Date.now() + ttlMs };
	return new Promise((resolve, reject) => {
		const req = t.objectStore('cache').put(row);
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

export async function cacheGet(key) {
	const t = await tx(['cache']);
	return new Promise((resolve, reject) => {
		const req = t.objectStore('cache').get(key);
		req.onsuccess = () => {
			const row = req.result;
			if (!row) return resolve(null);
			if (row.expiresAt < Date.now()) return resolve(null);
			resolve(row.value);
		};
		req.onerror = () => reject(req.error);
	});
}
