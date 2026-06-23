/**
 * Thin fetch wrapper over wp-admin/admin-ajax.php.
 *
 * All endpoints are POST-ed (admin-ajax expects POST or GET; we use GET for
 * read-only and POST for mutations). The `nonce` and `action` params are
 * always included.
 */

const data = window.amiData || {};

/**
 * admin-ajax endpoint, resolved against the CURRENT origin rather than the
 * (possibly stale) absolute URL baked into amiData. A PWA whose shell was
 * cached against an old host — e.g. a pre-cutover preview domain that is now
 * a different origin or 404s — would otherwise POST cross-origin, which the
 * site CSP (`connect-src 'self'`) blocks and which never reaches the live WP.
 * Reads still work from the SW cache, so only writes (sync) silently failed.
 */
function ajaxEndpoint() {
	try {
		const path = new URL(data.ajaxUrl, window.location.origin).pathname;
		return window.location.origin + path;
	} catch (e) {
		return window.location.origin + '/wp-admin/admin-ajax.php';
	}
}

/**
 * GET request to admin-ajax.
 */
export async function ajaxGet(action, params = {}, nonceKey = 'inspect') {
	const url = new URL(ajaxEndpoint());
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

	const endpoint = ajaxEndpoint();
	let res;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			credentials: 'same-origin',
			body,
		});
	} catch (e) {
		// Surface WHERE it tried to reach — distinguishes a dead/old host
		// (wrong address) from a genuine connectivity problem.
		throw new Error(`Could not reach ${endpoint} (${e.message})`);
	}
	if (!res.ok && res.status !== 400 && res.status !== 403 && res.status !== 404) {
		throw new Error(`HTTP ${res.status} from ${endpoint}`);
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
 *
 * Issue tickboxes (DB 2.11.2) are forwarded when supplied. The main
 * plugin's AJAX handler uses isset($_POST[$key]) to distinguish "ticked"
 * (= present, false or true) from "not assessed" (= absent from payload);
 * we mirror that by only appending the keys that the caller actually
 * carries on the `issues` object. Callers that don't supply `issues`
 * (legacy / queued findings created before this addition) round-trip as
 * NULL on those columns, exactly as before.
 *
 * @param {Object} args
 * @param {number} args.roundId
 * @param {number} args.plotId
 * @param {number} args.memberId
 * @param {1|2|3}  args.rating
 * @param {string} args.notes
 * @param {Object} [args.issues] Tickbox state. Any subset of:
 *   has_rubbish, has_overgrown_weeds, has_uncultivated_areas,
 *   has_derelict_structures, has_tenancy_breach (boolean) +
 *   tenancy_breach_description (string, only sent when truthy).
 */
export async function saveFinding({ roundId, plotId, memberId, rating, notes, issues, exemption, committeeNotes }) {
	const today = new Date().toISOString().slice(0, 10);

	const payload = {
		round_id:         roundId,
		plot_id:          plotId,
		member_id:        memberId,
		inspection_date:  today,
		findings_summary: notes || '',
	};

	if (exemption === 'exempt' || exemption === 'internal_review') {
		// Manual committee exemption / internal-review hold — not a graded
		// verdict (no category); carry the committee-only note. Always sent so
		// it can be cleared as well as set.
		payload.compliance_status = exemption;
		payload.requires_followup = 0;
		payload.committee_notes   = committeeNotes || '';
	} else {
		const ratingMap = {
			1: { category: 'category_1', status: 'compliant',     requiresFollowup: 0 },
			2: { category: 'category_2', status: 'non_compliant', requiresFollowup: 1 },
			3: { category: 'category_3', status: 'non_compliant', requiresFollowup: 1 },
		};
		const m = ratingMap[rating];
		if (!m) throw new Error('Invalid rating: ' + rating);
		payload.compliance_category = m.category;
		payload.compliance_status   = m.status;
		payload.requires_followup   = m.requiresFollowup;
	}

	if (issues && typeof issues === 'object') {
		const booleanKeys = [
			'has_rubbish',
			'has_overgrown_weeds',
			'has_uncultivated_areas',
			'has_derelict_structures',
			'has_tenancy_breach',
		];
		for (const k of booleanKeys) {
			if (Object.prototype.hasOwnProperty.call(issues, k)) {
				// Only append the key when the caller actively recorded
				// the boolean — preserves the NULL = "not assessed"
				// semantic on the server side.
				payload[k] = issues[k] ? 1 : 0;
			}
		}
		if (issues.tenancy_breach_description) {
			payload.tenancy_breach_description = issues.tenancy_breach_description;
		}
	}

	// Post to the inspections plugin's own save endpoint (am_inspect_save_finding)
	// with the inspect nonce. The old target (the committee admin form's
	// am_inspection_record_finding) used a different nonce action + required
	// fields, so this POST always failed and findings only ever queued.
	return ajaxPost('am_inspect_save_finding', payload, 'inspect');
}

/**
 * Edit an EXISTING finding (correct a mistake). Same rating → category/status
 * mapping as saveFinding, but targets the update endpoint by finding id. The
 * server authorises the edit (own finding, or chair/admin) + audit-logs it;
 * the recorded inspector(s) are not changed.
 *
 * @param {Object} args
 * @param {number} args.findingId
 * @param {1|2|3}  args.rating
 * @param {string} args.notes
 * @param {Object} [args.issues] Same shape as saveFinding's issues.
 */
export async function updateFinding({ findingId, rating, notes, issues, exemption, committeeNotes }) {
	const payload = {
		finding_id:       findingId,
		findings_summary: notes || '',
	};

	if (exemption === 'exempt' || exemption === 'internal_review') {
		// Re-classify to a committee exemption / review hold. No category;
		// always carry the committee note so it can be cleared as well as set.
		payload.compliance_status = exemption;
		payload.committee_notes   = committeeNotes || '';
	} else {
		const ratingMap = {
			1: { category: 'category_1', status: 'compliant' },
			2: { category: 'category_2', status: 'non_compliant' },
			3: { category: 'category_3', status: 'non_compliant' },
		};
		const m = ratingMap[rating];
		if (!m) throw new Error('Invalid rating: ' + rating);
		payload.compliance_category = m.category;
		payload.compliance_status   = m.status;
	}

	if (issues && typeof issues === 'object') {
		const booleanKeys = [
			'has_rubbish',
			'has_overgrown_weeds',
			'has_uncultivated_areas',
			'has_derelict_structures',
			'has_tenancy_breach',
		];
		for (const k of booleanKeys) {
			if (Object.prototype.hasOwnProperty.call(issues, k)) {
				payload[k] = issues[k] ? 1 : 0;
			}
		}
		if (issues.tenancy_breach_description) {
			payload.tenancy_breach_description = issues.tenancy_breach_description;
		}
	}

	return ajaxPost('am_inspect_update_finding', payload, 'inspect');
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
