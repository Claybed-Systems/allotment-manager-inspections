/**
 * Plot map — the "Map" tab of the plot picker.
 *
 * Read-only Leaflet map of a round's plots, each drawn as a circle marker
 * coloured by its inspection status (not inspected / Pass / Cat 2 / Cat 3 — the
 * same palette as the List badges). Tapping a marker opens a popup with an
 * "Inspect this plot" button that routes to the finding editor — the same
 * destination as a List row.
 *
 * Leaflet is bundled locally (public/vendor/leaflet/) and precached by the
 * service worker, so the map works offline once tiles for the area have been
 * seen. Mirrors the main plugin's member-map-view.js.
 *
 * Entry: renderPlotMap(container, { round, plots, tile, navigate, strings, focus }).
 * Returns { destroy() } so the caller can tear the Leaflet instance down when
 * the user toggles back to the List.
 */

import { badgeMeta, statusBucket } from '../components/badge.js';

// Plot styling per COMPLIANCE STATUS — keyed on statusBucket(), the same axis
// the filter chips use, so filtering to "Non-compliant" turns the map into
// exactly the red plots and nothing has to be reconciled by eye.
//
// Status, not category. Colouring by `compliance_category` drew a Category 1
// plot failed for rubbish as a green "pass" while its own popup said
// Non-compliant — the two axes are independent (see components/badge.js).
//
// One red covers non-compliance rather than Cat 2 amber / Cat 3 terracotta.
// At a glance across a section the question is "who do I need to see?", which
// is one question with one answer; severity is a second question, and the
// popup badge and the list still answer it with the Cat 2 / Cat 3 label.
//
// Light fills over satellite imagery, with a darker stroke to hold the edge:
// `fillColor` is what reads at a glance, `color` is what keeps the plot's
// footprint legible against the photograph under it.
const MARKER_STYLE = {
	compliant:       { color: '#2d6e3a', fillColor: '#8fce95' }, // Passed — light green
	non_compliant:   { color: '#b03a2e', fillColor: '#f2a09a' }, // Non-compliant — light red
	exempt:          { color: '#1f5d8a', fillColor: '#9ec9e8' }, // Exempt — light blue
	// A new tenant inside the 1 March grace period IS an exemption: the server
	// records the finding auto-exempt and issues no notice. Same state to the
	// inspector walking the site, so the same colour.
	new_tenant:      { color: '#1f5d8a', fillColor: '#9ec9e8' }, // Also exempt — light blue
	// Not a verdict yet — the committee is still deciding. Amber reads as
	// "pending" against the settled three, and matches its badge.
	internal_review: { color: '#8a5d1d', fillColor: '#e8a64e' }, // Under review — amber
	none:            { color: '#777777', fillColor: '#bdbdbd' }, // Not inspected — grey
};

// Fallback for an unrecognised bucket.
const MARKER_STYLE_FALLBACK = MARKER_STYLE.none;

// Legend order: the settled verdicts first, then the unsettled, then the
// not-yet-done. Only the buckets actually on the map are drawn — see
// buildLegend().
const LEGEND_ORDER = ['compliant', 'non_compliant', 'exempt', 'new_tenant', 'internal_review', 'none'];

// Zoom used when the map opens on one searched-for plot. 19 is the deepest
// zoom the tile providers serve (Esri imagery stops there, which is why the
// layer sets maxNativeZoom), so it is as close as the map goes.
const FOCUS_ZOOM = 19;

// Loaded once per page; reused across List/Map toggles.
let leafletPromise = null;

// Last map view (center + zoom), kept module-scoped so it survives the SPA's
// page re-render when the inspector goes map → plot → back to map. Tagged with
// the round so it isn't restored onto a different round.
let savedView = null;

// Reference zoom for label scaling (#4). At this zoom a label renders at its
// base font size; beyond it the font grows GENTLY (roughly doubling every two
// zoom levels, not every one) so labels stay proportional to the plot box
// without ballooning past it. Clamped readable-small .. modest.
const LABEL_REF_ZOOM = 19;

/**
 * Lazy-load the bundled Leaflet CSS + JS. Resolves once window.L is ready.
 */
function ensureLeaflet() {
	if (typeof window.L !== 'undefined') {
		return Promise.resolve();
	}
	if (leafletPromise) {
		return leafletPromise;
	}

	const base = (window.amiData && window.amiData.pluginUrl) || '';

	leafletPromise = new Promise((resolve, reject) => {
		if (!document.querySelector('link[data-ami-leaflet]')) {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = base + 'public/vendor/leaflet/leaflet.css';
			link.setAttribute('data-ami-leaflet', '');
			document.head.appendChild(link);
		}

		const script = document.createElement('script');
		script.src = base + 'public/vendor/leaflet/leaflet.js';
		script.async = true;
		script.setAttribute('data-ami-leaflet-js', '');
		script.onload = () => resolve();
		script.onerror = () => {
			script.remove();       // drop the failed node so the next attempt is clean
			leafletPromise = null; // allow a retry on the next toggle
			reject(new Error('Leaflet failed to load'));
		};
		document.head.appendChild(script);
	});

	return leafletPromise;
}

function styleFor(styleKey) {
	const base = MARKER_STYLE[styleKey] || MARKER_STYLE_FALLBACK;
	return {
		color: base.color,
		fillColor: base.fillColor,
		fillOpacity: 0.85,
		radius: 8,
		weight: 2,
	};
}

// Polygon styling for a plot footprint — same palette as the markers, but a
// translucent fill so the satellite imagery shows through.
function polyStyleFor(styleKey) {
	const base = MARKER_STYLE[styleKey] || MARKER_STYLE_FALLBACK;
	return { color: base.color, weight: 2, fillColor: base.fillColor, fillOpacity: 0.45 };
}

// Convert a plot's stored geometry (centroid + width/height in pixels at zoom
// 19 + rotation in degrees, exactly as the admin Map Editor stores it) into the
// four corner [lat,lng] points of its real-world rotated rectangle, so Leaflet
// scales it natively with the map instead of a fixed-size dot. Returns null when
// the plot has no usable dimensions (then the caller falls back to a marker).
function rectCorners(plot) {
	const w = Number(plot.width);
	const h = Number(plot.height);
	if (!(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)) {
		return null;
	}
	const latRad = plot.lat * Math.PI / 180;
	// Ground metres per pixel at zoom 19 for this latitude (Web Mercator).
	const mPerPx = 156543.03392 * Math.cos(latRad) / Math.pow(2, 19);
	const halfW = (w * mPerPx) / 2; // east axis, pre-rotation
	const halfH = (h * mPerPx) / 2; // south axis, pre-rotation
	const theta = (Number(plot.rotation) || 0) * Math.PI / 180; // CSS clockwise, y-down
	const cosT = Math.cos(theta);
	const sinT = Math.sin(theta);
	const mPerDegLat = 111320;
	const mPerDegLng = 111320 * Math.cos(latRad);
	// (east, south) metre offsets of each corner before rotation.
	const offsets = [[-halfW, -halfH], [halfW, -halfH], [halfW, halfH], [-halfW, halfH]];
	return offsets.map(function (o) {
		const ex = o[0];
		const sy = o[1];
		// Replicate the admin map's CSS rotate(theta) on (x=east, y=south).
		const exR = ex * cosT - sy * sinT;
		const syR = ex * sinT + sy * cosT;
		return [plot.lat - syR / mPerDegLat, plot.lng + exR / mPerDegLng];
	});
}

/**
 * Build the badge element for a plot's verdict, reusing the existing
 * .ami-badge CSS. Status is passed alongside the category so an exempt or
 * under-review plot reads as such rather than as "Not inspected".
 */
function badgeEl(category, strings, status) {
	const [cls, label] = badgeMeta(category, strings, status);
	const span = document.createElement('span');
	span.className = 'ami-badge ' + cls;
	span.textContent = label;
	return span;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
	return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
		return HTML_ESCAPES[c];
	});
}

// Always-on plot label, rotated to run ALONG the plot like the admin Map
// Editor (so labels sit on their strip instead of colliding horizontally).
// A non-interactive divIcon marker so taps fall through to the plot's popup.
// The rotation is the same CSS rotate() the admin map and our footprint use.
function labelFor(plot) {
	const text = plot.tenantName ? `${plot.plotNumber} · ${plot.tenantName}` : plot.plotNumber;
	// Number.isFinite (matching rectCorners) — a non-finite value would emit
	// an invalid rotate() into the inline style.
	const rotNum = Number(plot.rotation);
	const rot = Number.isFinite(rotNum) ? rotNum : 0;
	const icon = window.L.divIcon({
		className: 'ami-plot-label-icon',
		html: `<span class="ami-plot-label-text" style="transform: rotate(${rot}deg)">${escapeHtml(text)}</span>`,
		iconSize: [160, 20],
		iconAnchor: [80, 10],
	});
	return window.L.marker([plot.lat, plot.lng], { icon: icon, interactive: false, keyboard: false });
}

/**
 * Popup DOM for a plot: number, tenant, status badge, and an Inspect button.
 * Built as a DOM node (not an HTML string) so the button's click handler can be
 * bound directly.
 */
function buildPopup(plot, round, strings, navigate) {
	const wrap = document.createElement('div');
	wrap.className = 'ami-map-popup';

	const num = document.createElement('div');
	num.className = 'ami-map-popup__num';
	num.textContent = plot.plotNumber;

	const name = document.createElement('div');
	name.className = 'ami-map-popup__name';
	if (plot.tenantName) {
		name.textContent = plot.tenantName;
	} else {
		name.textContent = 'Vacant';
		name.classList.add('is-empty');
	}

	wrap.append(num, name);

	// New tenant — exempt from notices this round (still recordable from the
	// finding screen; the server saves it exempt).
	if (plot.isNewTenant) {
		const note = document.createElement('div');
		note.className = 'ami-map-popup__note';
		note.textContent = 'New tenant — exempt';
		wrap.append(note);
	}

	// Vacant plots are shown but not inspectable — no tenant to record against,
	// so omit the Inspect button (and the status badge, which would be "Not
	// inspected" and misleading).
	if (plot.isVacant) {
		const note = document.createElement('div');
		note.className = 'ami-map-popup__note';
		note.textContent = 'Not inspectable';
		wrap.append(note);
		return wrap;
	}

	const status = document.createElement('div');
	status.className = 'ami-map-popup__status';
	status.appendChild(badgeEl(plot.currentCategory, strings, plot.currentStatus));

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'ami-btn ami-map-popup__btn';
	btn.textContent = strings.inspectCta || 'Inspect this plot';
	btn.addEventListener('click', () => navigate(`/round/${round.id}/plot/${plot.id}`));

	wrap.append(status, btn);
	return wrap;
}

/**
 * Legend row mapping each colour to its meaning.
 *
 * Only the buckets actually on the map are listed. There are six possible
 * colours and a typical round shows three; a legend naming colours that are
 * not on screen makes the reader hunt for plots that do not exist, and on a
 * phone it costs a line of map to do it.
 *
 * @param {Object} strings Localised labels.
 * @param {Object[]} plots The plots being drawn (already filtered).
 */
function buildLegend(strings, plots) {
	const legend = document.createElement('div');
	legend.className = 'ami-map-legend';

	const present = new Set((plots || []).map(statusBucket));
	const labels = {
		compliant:       strings.cat1,
		non_compliant:   strings.statusNonCompliant,
		exempt:          strings.statusExempt,
		new_tenant:      strings.statusNewTenant,
		internal_review: strings.statusUnderReview,
		none:            strings.notInspected,
	};
	const items = LEGEND_ORDER
		.filter((key) => present.has(key) && MARKER_STYLE[key])
		.map((key) => [key, labels[key]]);

	for (const [key, label] of items) {
		const item = document.createElement('span');
		item.className = 'ami-map-legend__item';
		const dot = document.createElement('span');
		dot.className = 'ami-map-legend__dot';
		dot.style.background = MARKER_STYLE[key].fillColor;
		dot.style.borderColor = MARKER_STYLE[key].color;
		const text = document.createElement('span');
		text.textContent = label;
		item.append(dot, text);
		legend.appendChild(item);
	}
	return legend;
}

/**
 * The "polygons not set up yet" empty state — shown when no plot in the round
 * has been positioned in the admin Map Editor.
 */
function renderEmpty(container, strings) {
	container.innerHTML = '';
	const empty = document.createElement('div');
	empty.className = 'ami-empty';
	const title = document.createElement('p');
	const strong = document.createElement('strong');
	strong.textContent = strings.mapEmptyTitle || 'Map view not set up yet.';
	title.appendChild(strong);
	const body = document.createElement('p');
	body.textContent = strings.mapEmptyBody
		|| "The plots in this section need to be positioned in the admin's Map Editor before the map can render them. For now, use the list view.";
	empty.append(title, body);
	container.appendChild(empty);
}

/**
 * Render the map. Returns { destroy() }.
 */
export async function renderPlotMap(container, { round, plots, tile, navigate, strings, focus }) {
	const s = strings || {};
	let map = null;
	let destroyed = false;
	let invalidateTimer = null;

	const handle = {
		destroy() {
			destroyed = true;
			if (invalidateTimer) {
				clearTimeout(invalidateTimer);
				invalidateTimer = null;
			}
			if (map) {
				map.remove();
				map = null;
			}
		},
	};

	// Only plots with a real centroid can be drawn.
	const placed = (plots || []).filter(
		(p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
	);

	if (!placed.length) {
		renderEmpty(container, s);
		return handle;
	}

	// Loading state while Leaflet streams in (cheap on a cold cache).
	container.innerHTML = '';
	const loading = document.createElement('div');
	loading.className = 'ami-empty';
	loading.textContent = s.loading || 'Loading…';
	container.appendChild(loading);

	try {
		await ensureLeaflet();
	} catch (e) {
		if (destroyed) {
			return handle;
		}
		container.innerHTML = '';
		const err = document.createElement('div');
		err.className = 'ami-error';
		err.textContent = s.mapOffline
			|| 'The map could not load. Connect to the internet once to cache it, then try again.';
		container.appendChild(err);
		return handle;
	}

	// The user may have toggled back to List while Leaflet was loading.
	if (destroyed) {
		return handle;
	}

	const L = window.L;

	container.innerHTML = '';
	const mapEl = document.createElement('div');
	mapEl.className = 'ami-map';
	container.appendChild(mapEl);
	container.appendChild(buildLegend(s, placed));

	const t = tile || {};
	map = L.map(mapEl, { scrollWheelZoom: false });
	L.tileLayer(t.url || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
		attribution: t.attribution || '',
		// maxZoom is how far the user may zoom; maxNativeZoom is the deepest
		// zoom the provider actually serves tiles for (Esri imagery stops at
		// 19). Honouring maxNativeZoom makes Leaflet UPSCALE those tiles past
		// it instead of requesting non-existent deeper tiles — without it the
		// provider returns "Map data not yet available" placeholders when the
		// inspector zooms in. (The admin Map Editor sets this; we must too.)
		maxZoom: t.maxZoom || 19,
		maxNativeZoom: t.maxNativeZoom,
		subdomains: t.subdomains || 'abc',
	}).addTo(map);

	const latlngs = [];
	for (const plot of placed) {
		// Draw the plot's real footprint (a rotated rectangle that scales with
		// the map) when we have its dimensions; fall back to a dot otherwise.
		const corners = rectCorners(plot);
		const styleKey = statusBucket(plot);
		const style = corners ? polyStyleFor(styleKey) : styleFor(styleKey);
		// Vacant plots are shown but not inspectable — render them faded + dashed
		// so they read as "known empty", not "occupied, awaiting inspection".
		if (plot.isVacant) {
			style.dashArray = '4 5';
			style.opacity = 0.6;
			style.fillOpacity = corners ? 0.12 : 0.4;
		}
		const layer = corners
			? L.polygon(corners, style).addTo(map)
			: L.circleMarker([plot.lat, plot.lng], style).addTo(map);
		// Defer the popup DOM until it's actually opened (popups open rarely;
		// building ~190 up front is wasted work on a mobile PWA).
		layer.bindPopup(() => buildPopup(plot, round, s, navigate));
		// Always-on label, rotated to run along the plot (admin-map style).
		labelFor(plot).addTo(map);
		latlngs.push([plot.lat, plot.lng]);
	}

	// A searched-for plot wins over both the remembered view and the fit: the
	// inspector has just asked for THAT plot by name, so open on it rather than
	// on wherever they were standing last time. FOCUS_ZOOM is the deepest the
	// tiles go, which is where a single plot fills the screen.
	//
	// The caller picks which plot (the lowest-numbered match); this only has to
	// honour it. Guarded on real coordinates because a plot with none cannot be
	// flown to, and setView(NaN) leaves Leaflet with a broken view rather than
	// throwing.
	if (focus && Number.isFinite(focus.lat) && Number.isFinite(focus.lng)) {
		map.setView([focus.lat, focus.lng], Math.min(FOCUS_ZOOM, t.maxZoom || FOCUS_ZOOM));
	} else if (savedView && savedView.roundId === round.id && Array.isArray(savedView.center)) {
		// #3 Restore the remembered view for this round; otherwise fit all plots.
		map.setView(savedView.center, savedView.zoom);
	} else {
		map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 19 });
	}
	// Remember it on every pan/zoom (moveend fires for both).
	map.on('moveend', () => {
		if (!map) return;
		const c = map.getCenter();
		savedView = { roundId: round.id, center: [c.lat, c.lng], zoom: map.getZoom() };
	});

	// #4 Scale the labels with zoom so they stay proportional to the plot box
	// (which scales natively) instead of looking ever-smaller as you zoom in.
	// One CSS-variable write drives all labels.
	function applyLabelScale() {
		if (!map) return;
		// 0.5 exponent = doubles every 2 zoom levels (gentle); clamp keeps it
		// readable when zoomed out and stops it overflowing when zoomed in.
		const scale = Math.max(0.85, Math.min(2.2, Math.pow(2, (map.getZoom() - LABEL_REF_ZOOM) * 0.5)));
		mapEl.style.setProperty('--ami-label-scale', String(scale));
	}
	map.on('zoomend', applyLabelScale);
	applyLabelScale();

	// The tab content is swapped in synchronously; nudge Leaflet once layout
	// settles so tiles fill the container. Tracked so destroy() can cancel it
	// if the user toggles back to List before it fires.
	invalidateTimer = setTimeout(() => {
		invalidateTimer = null;
		if (map) {
			map.invalidateSize();
		}
	}, 200);

	return handle;
}
