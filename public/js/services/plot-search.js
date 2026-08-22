/**
 * Plot search — the matcher shared by the round's List and Map.
 *
 * One module so the two views cannot drift: an inspector who types a tenant's
 * name into the List and then taps Map must be looking at the same set of
 * plots, not at two independent interpretations of the same string.
 *
 * The website's admin map had exactly that class of bug (ams#902): its search
 * tested the DOM rather than the plot data, so any plot not currently drawn was
 * invisible to it and an ordinary plot number reported "no matches". Everything
 * here works on the plot objects the API returned, never on what is on screen.
 */

/**
 * Normalise raw input into a comparable query.
 *
 * @param {*} raw Whatever the input element handed us.
 * @returns {string} Trimmed, lowercased; '' means "no search".
 */
export function normaliseQuery(raw) {
	return String(raw == null ? '' : raw).trim().toLowerCase();
}

/**
 * Does this plot match the query?
 *
 * Matches the plot number or the tenant's name, so "B15" and "Lovelace" both
 * work — a walking inspector knows one or the other, rarely both.
 *
 * @param {Object} plot A plot from listPlots().
 * @param {string} q    A query from normaliseQuery().
 * @returns {boolean}
 */
export function matchesQuery(plot, q) {
	if (!q || !plot) {
		return false;
	}
	const haystack = `${plot.plotNumber || ''} ${plot.tenantName || ''}`.toLowerCase();
	return haystack.indexOf(q) !== -1;
}

/**
 * The plots matching the query, in the order they were given.
 *
 * ORDER IS LOAD-BEARING and belongs to the server: list_plots sorts by
 * prefix, then number, then subdivision (plot_number_order_sql, #42), which is
 * the same order the committee's own lists use. Preserving it here is what
 * makes "the first match" mean "the lowest-numbered match" — so do not sort
 * this again on the client, or the two orders can disagree on subdivided
 * plots and the map will fly to V3.2 while the list shows V3.1 first.
 *
 * An empty query matches everything, so this composes with the status filter:
 * "not searching" must not mean "nothing to show".
 *
 * @param {Array} plots Plots in server order.
 * @param {string} q    A query from normaliseQuery().
 * @returns {Array} The matching subset, order preserved.
 */
export function filterPlots(plots, q) {
	const all = plots || [];
	if (!q) {
		return all;
	}
	return all.filter((p) => matchesQuery(p, q));
}

/**
 * The lowest-numbered matching plot, or null.
 *
 * This is what the map flies to. A tenant holding B15, B17 and B19 should land
 * on B15: it is where they start walking, and it is the answer that does not
 * depend on row ids.
 *
 * @param {Array} plots Plots in server order.
 * @param {string} q    A query from normaliseQuery().
 * @returns {Object|null}
 */
export function firstMatch(plots, q) {
	if (!q) {
		return null;
	}
	return filterPlots(plots, q).find((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)) || null;
}
