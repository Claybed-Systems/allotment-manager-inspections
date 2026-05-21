/**
 * Thin fetch wrapper over wp-admin/admin-ajax.php.
 *
 * All endpoints are POST-ed (admin-ajax expects POST or GET; we use GET for
 * read-only and POST for mutations). The `nonce` and `action` params are
 * always included.
 */

const data = window.amiData || {};

/**
 * GET request to admin-ajax.
 */
export async function ajaxGet(action, params = {}, nonceKey = 'inspect') {
	const url = new URL(data.ajaxUrl);
	url.searchParams.set('action', action);
	url.searchParams.set('nonce', data.nonces[nonceKey]);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) url.searchParams.set(k, v);
	}

	const res = await fetch(url.toString(), { credentials: 'same-origin' });
	if (!res.ok && res.status !== 400 && res.status !== 403 && res.status !== 404) {
		throw new Error(`HTTP ${res.status}`);
	}
	const json = await res.json();
	if (!json.success) {
		const msg = (json.data && json.data.message) || 'Request failed';
		const err = new Error(msg);
		err.code = res.status;
		throw err;
	}
	return json.data;
}

/**
 * POST request to admin-ajax. FormData-style for compatibility with WP nonces.
 */
export async function ajaxPost(action, params = {}, nonceKey = 'inspect', { isFormData = false } = {}) {
	let body;
	if (isFormData) {
		body = params; // caller passes a FormData already
		body.append('action', action);
		body.append('nonce', data.nonces[nonceKey]);
	} else {
		body = new FormData();
		body.append('action', action);
		body.append('nonce', data.nonces[nonceKey]);
		for (const [k, v] of Object.entries(params)) {
			if (v !== undefined && v !== null) body.append(k, v);
		}
	}

	const res = await fetch(data.ajaxUrl, {
		method: 'POST',
		credentials: 'same-origin',
		body,
	});
	if (!res.ok && res.status !== 400 && res.status !== 403 && res.status !== 404) {
		throw new Error(`HTTP ${res.status}`);
	}
	const json = await res.json();
	if (!json.success) {
		const msg = (json.data && json.data.message) || 'Request failed';
		const err = new Error(msg);
		err.code = res.status;
		throw err;
	}
	return json.data;
}

// Endpoint shortcuts.

export const listRounds = () => ajaxGet('am_inspect_list_rounds');
export const listPlots = (roundId) => ajaxGet('am_inspect_list_plots', { round_id: roundId });
export const getPlot = (roundId, plotId) => ajaxGet('am_inspect_get_plot', { round_id: roundId, plot_id: plotId });

/**
 * Save a finding. Uses the existing am_inspection_record_finding endpoint
 * registered by the main allotment-manager plugin. Maps the inspector's
 * 1/2/3 rating to the schema's compliance_category enum + status.
 */
export async function saveFinding({ roundId, plotId, memberId, rating, notes }) {
	const ratingMap = {
		1: { category: 'category_1', status: 'compliant',     requiresFollowup: 0 },
		2: { category: 'category_2', status: 'non_compliant', requiresFollowup: 1 },
		3: { category: 'category_3', status: 'non_compliant', requiresFollowup: 1 },
	};
	const m = ratingMap[rating];
	if (!m) throw new Error('Invalid rating: ' + rating);

	const today = new Date().toISOString().slice(0, 10);

	return ajaxPost('am_inspection_record_finding', {
		round_id:             roundId,
		plot_id:              plotId,
		member_id:            memberId,
		inspection_date:      today,
		compliance_category:  m.category,
		compliance_status:    m.status,
		findings_summary:     notes || '',
		requires_followup:    m.requiresFollowup,
	}, 'recordFinding');
}

/**
 * Upload a photo blob. Uses the main plugin's am_inspection_upload_photo
 * endpoint, which handles Google Drive upload + DB record creation.
 */
export async function uploadPhoto({ findingId, blob, filename, caption }) {
	const fd = new FormData();
	fd.append('finding_id', findingId);
	fd.append('photo', blob, filename || 'photo.jpg');
	if (caption) fd.append('caption', caption);
	return ajaxPost('am_inspection_upload_photo', fd, 'uploadPhoto', { isFormData: true });
}
