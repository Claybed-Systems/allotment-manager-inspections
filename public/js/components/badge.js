/**
 * Shared inspection-status badge mapping.
 *
 * Both the plot list (plot-picker.js, which renders an HTML string) and the
 * plot map (plot-map.js, which renders a DOM node) show the same compliance
 * category as a coloured badge. The category → [css-class, label] mapping lives
 * here so the two renderers can't drift.
 *
 * @param {string|null} category One of 'category_1' | 'category_2' | 'category_3', or null/unknown.
 * @param {Object} strings Localised labels (window.amiData.strings).
 * @returns {[string, string]} A [cssClass, label] tuple.
 */
export function badgeMeta(category, strings) {
	const s = strings || {};
	const map = {
		category_1: ['ami-badge--cat1', s.cat1],
		category_2: ['ami-badge--cat2', s.cat2],
		category_3: ['ami-badge--cat3', s.cat3],
	};
	return map[category] || ['ami-badge--none', s.notInspected];
}
