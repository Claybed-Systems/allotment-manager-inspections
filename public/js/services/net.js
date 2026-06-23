/**
 * Network / photo-upload policy.
 *
 * Photos are large; findings are tiny. In the field on mobile data a slow photo
 * upload used to block the inspector (the save handler awaited every upload
 * before moving on). Now photos are always QUEUED and drained by the background
 * sync loop, and this module decides WHEN the loop may spend mobile data on them:
 *
 *   - "Wi-Fi only" OFF (default): upload whenever online.
 *   - "Wi-Fi only" ON: upload photos only on Wi-Fi. Findings still sync on any
 *     connection. Where the browser exposes the connection type (Android
 *     Chrome) we auto-detect Wi-Fi and auto-resume; where it doesn't (iOS
 *     Safari has no Network Information API) we HOLD photos and the inspector
 *     taps "Upload photos now" on the Sync queue when they're back on Wi-Fi.
 *
 * The preference lives in localStorage (per device/browser), not the server —
 * it's a field-data-cost choice, not account state.
 */

const PREF_KEY = 'ami_photo_wifi_only';

/** Safe localStorage read (private mode / disabled storage can throw). */
function lsGet(key) {
	try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, value) {
	try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

/** Whether the "upload photos on Wi-Fi only" preference is on. */
export function isWifiOnly() {
	return lsGet(PREF_KEY) === '1';
}

/** Set the "upload photos on Wi-Fi only" preference. */
export function setWifiOnly(on) {
	lsSet(PREF_KEY, on ? '1' : '0');
}

/** The Network Information API object, if the browser exposes one. */
function connection() {
	return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

/**
 * Connection type string ('wifi' | 'cellular' | 'ethernet' | …) when the
 * browser reports it, else null. iOS Safari returns null (no NetInfo API).
 */
export function connectionType() {
	const c = connection();
	return c && c.type ? c.type : null;
}

/** Whether this browser can tell Wi-Fi from mobile data at all. */
export function canDetectConnection() {
	return connectionType() !== null;
}

/** Whether we're on an unmetered connection (Wi-Fi / wired). */
export function isOnWifi() {
	const t = connectionType();
	return t === 'wifi' || t === 'ethernet' || t === 'wimax';
}

/**
 * Should the sync loop upload photos right now?
 *   - force (the "Upload now" button): always yes.
 *   - Wi-Fi-only off: yes whenever online.
 *   - Wi-Fi-only on + detectable: only on Wi-Fi.
 *   - Wi-Fi-only on + NOT detectable (iOS): no — hold until the user forces it.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.force]
 * @returns {boolean}
 */
export function photosAllowedNow({ force = false } = {}) {
	if (force) return true;
	if (!isWifiOnly()) return true;
	if (!canDetectConnection()) return false; // iOS: hold; "Upload now" overrides
	return isOnWifi();
}

/**
 * Subscribe to connection changes (Android Chrome fires these on Wi-Fi↔cellular
 * switches) so the caller can re-attempt a sync. No-op + no-op unsubscribe where
 * the API is absent.
 *
 * @param {() => void} cb
 * @returns {() => void} unsubscribe
 */
export function onConnectionChange(cb) {
	const c = connection();
	if (!c || typeof c.addEventListener !== 'function') return () => {};
	c.addEventListener('change', cb);
	return () => {
		try { c.removeEventListener('change', cb); } catch (e) { /* ignore */ }
	};
}

/** Short human description of the current connection, for the settings UI. */
export function describeConnection() {
	if (!canDetectConnection()) return "this device can't report Wi-Fi vs mobile data";
	return isOnWifi() ? 'on Wi-Fi' : 'on mobile data';
}
