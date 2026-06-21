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
 * Entry: renderPlotMap(container, { round, plots, tile, navigate, strings }).
 * Returns { destroy() } so the caller can tear the Leaflet instance down when
 * the user toggles back to the List.
 */

import { badgeMeta } from '../components/badge.js';

// Circle-marker styling per compliance category. Hexes mirror the .ami-badge
// rules in inspect.css so the map and the list agree at a glance.
const MARKER_STYLE = {
	category_1: { color: '#2d6e3a', fillColor: '#6aa56f' }, // Pass — green
	category_2: { color: '#8a5d1d', fillColor: '#e8a64e' }, // Cat 2 — amber
	category_3: { color: '#7a3320', fillColor: '#c86f4a' }, // Cat 3 — terracotta
	_none:      { color: '#777777', fillColor: '#bdbdbd' }, // Not inspected — grey
};

// Loaded once per page; reused across List/Map toggles.
let leafletPromise = null;

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

function styleFor(category) {
	const base = MARKER_STYLE[category] || MARKER_STYLE._none;
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
function polyStyleFor(category) {
	const base = MARKER_STYLE[category] || MARKER_STYLE._none;
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
 * Build the badge element for a category, reusing the existing .ami-badge CSS.
 */
function badgeEl(category, strings) {
	const [cls, label] = badgeMeta(category, strings);
	const span = document.createElement('span');
	span.className = 'ami-badge ' + cls;
	span.textContent = label;
	return span;
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

	const status = document.createElement('div');
	status.className = 'ami-map-popup__status';
	status.appendChild(badgeEl(plot.currentCategory, strings));

	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'ami-btn ami-map-popup__btn';
	btn.textContent = strings.inspectCta || 'Inspect this plot';
	btn.addEventListener('click', () => navigate(`/round/${round.id}/plot/${plot.id}`));

	wrap.append(num, name, status, btn);
	return wrap;
}

/**
 * Legend row mapping each colour to its meaning.
 */
function buildLegend(strings) {
	const legend = document.createElement('div');
	legend.className = 'ami-map-legend';
	const items = [
		['_none', strings.notInspected],
		['category_1', strings.cat1],
		['category_2', strings.cat2],
		['category_3', strings.cat3],
	];
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
export async function renderPlotMap(container, { round, plots, tile, navigate, strings }) {
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
	container.appendChild(buildLegend(s));

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
		const layer = corners
			? L.polygon(corners, polyStyleFor(plot.currentCategory)).addTo(map)
			: L.circleMarker([plot.lat, plot.lng], styleFor(plot.currentCategory)).addTo(map);
		// Build the tooltip as a DOM node, not a string: Leaflet injects string
		// content via innerHTML, and plot numbers / tenant names are
		// admin/import-sourced. textContent keeps it safe regardless of upstream
		// sanitisation (matches buildPopup's DOM-node approach).
		const tipEl = document.createElement('span');
		tipEl.textContent = plot.tenantName ? `${plot.plotNumber} · ${plot.tenantName}` : plot.plotNumber;
		// Permanent so the plot number + tenant are always on the map, not just
		// on hover; centred on the plot's footprint. Tooltips are non-interactive
		// (pointer-events: none) so taps still fall through to open the popup.
		layer.bindTooltip(tipEl, { permanent: true, direction: 'center', className: 'ami-plot-label' });
		layer.bindPopup(buildPopup(plot, round, s, navigate));
		latlngs.push([plot.lat, plot.lng]);
	}

	map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 19 });

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
