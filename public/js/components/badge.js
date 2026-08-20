/**
 * Shared inspection-verdict badge mapping.
 *
 * Both the plot list (plot-picker.js, which renders an HTML string) and the
 * plot map (plot-map.js, which renders a DOM node) show the same verdict as a
 * coloured badge. The verdict → [css-class, label] mapping lives here so the
 * two renderers can't drift.
 *
 * A finding carries TWO INDEPENDENT axes, and the badge used to read only one:
 *
 *   - `compliance_status` is the committee's verdict — the axis the website's
 *     round screen badges and filters by, and the axis "non-compliant" names.
 *   - `compliance_category` (category_1..3) measures CULTIVATION. It is NULL on
 *     an exempt / under-review finding, and it does NOT imply the status: a
 *     plot failed for rubbish, derelict structures or a tenancy breach while
 *     being well cultivated is Category 1 AND non-compliant. There was one such
 *     plot in the live 2026 round (see Inspect_Ajax::fetch_plot_rows).
 *
 * So the status decides the badge and the category refines it. Reading the
 * category first badged that Category 1 failure as "Pass", and rendered every
 * exempt or under-review plot as "Not inspected" although the inspector had
 * already recorded it.
 *
 * @param {string|null} category One of 'category_1' | 'category_2' | 'category_3', or null/unknown.
 * @param {Object} strings Localised labels (window.amiData.strings).
 * @param {string|null} [status] compliance_status of the same finding, when known.
 * @returns {[string, string]} A [cssClass, label] tuple.
 */
export function badgeMeta(category, strings, status) {
	const s = strings || {};

	switch (status) {
		case 'compliant':
			return [badgeClass('compliant'), s.cat1];
		case 'non_compliant':
			// Colour says non-compliant; the LABEL carries the severity. Cat 2 and
			// Cat 3 are one colour here and one colour on the map, because "who do
			// I need to see?" is one question — see plot-map.js MARKER_STYLE.
			if (category === 'category_2') return [badgeClass('non_compliant'), s.cat2];
			if (category === 'category_3') return [badgeClass('non_compliant'), s.cat3];
			return [badgeClass('non_compliant'), s.statusNonCompliant];
		case 'exempt':
			return [badgeClass('exempt'), s.statusExempt];
		case 'new_tenant':
			return [badgeClass('new_tenant'), s.statusNewTenant];
		case 'internal_review':
			return [badgeClass('internal_review'), s.statusUnderReview];
		default:
			break;
	}

	// No status: an OFFLINE payload cached by the service worker before
	// `currentStatus` was added. Fall back to the category-only mapping this
	// badge used to have, so a phone with no signal still labels its rows.
	const byCategory = {
		category_1: [badgeClass('compliant'), s.cat1],
		category_2: [badgeClass('non_compliant'), s.cat2],
		category_3: [badgeClass('non_compliant'), s.cat3],
	};
	return byCategory[category] || [badgeClass('none'), s.notInspected];
}

/**
 * The CSS class for a status bucket.
 *
 * Named for the BUCKET, not the cultivation category. The classes used to be
 * --cat1/--cat2/--cat3, which stopped describing what they coloured the moment
 * a Cat 2 and a Cat 3 became the same red: a reader had to know that --cat2
 * was not, in fact, a Cat 2 colour. Derived here so the class is always
 * `ami-badge--` + the bucket statusBucket() returns, and the badge, the filter
 * chip and the map polygon cannot drift apart.
 *
 * @param {string} bucket A statusBucket() value.
 * @returns {string} CSS class.
 */
function badgeClass(bucket) {
	return 'ami-badge--' + bucket.replace(/_/g, '-');
}

/**
 * The bucket a plot falls into for the plot list's filter.
 *
 * Mirrors the website's round screen, which filters on `compliance_status`
 * plus a "not inspected" bucket for the plots with no finding yet. Reads the
 * same axis as badgeMeta() above, so a row can never sit under a chip that
 * disagrees with the badge it is wearing.
 *
 * The category fallback is for the same cached-payload case, using the mapping
 * api.js applies when it WRITES a finding — so it reproduces what the server
 * stored for anything this app recorded.
 *
 * @param {Object} plot A plot row from am_inspect_list_plots.
 * @returns {string} A compliance_status, or 'none' for a plot with no finding.
 */
export function statusBucket(plot) {
	if (plot.currentStatus) return plot.currentStatus;
	if (!plot.currentFindingId) return 'none';
	const fromCategory = {
		category_1: 'compliant',
		category_2: 'non_compliant',
		category_3: 'non_compliant',
	};
	return fromCategory[plot.currentCategory] || 'none';
}
