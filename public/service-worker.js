/**
 * Inspector PWA service worker.
 *
 * Pre-caches the app shell, CSS, JS modules and manifest on install. Runtime
 * caches API responses (network-first with cache fallback) and map tiles
 * (stale-while-revalidate, bounded). On navigation requests within
 * /inspect/, falls back to the cached shell so the app boots offline.
 */

// Bump on any shipped JS/CSS/HTML change so already-installed PWAs
// evict their pre-cached shell and pick up the new bytes on next load.
// 'v2' adds the issue-tickbox UI (finding-editor) + the api/sync/store
// pass-through for the 2.11.2 fields.
// 'v3' adds the plot Map view (plot-map.js) + the bundled Leaflet library,
// precached so the map works offline.
// 'v4' adds the shared badge component (js/components/badge.js).
// 'v5' map honours the tile provider's maxNativeZoom (upscale past Esri's z19
// instead of showing "Map data not yet available" when zooming in).
// 'v6' map draws plot footprints (rotated rectangles that scale with the map)
// instead of fixed-size dots.
// 'v7' plot number + tenant are permanent labels on the map, not hover-only.
// 'v8' plot labels are rotated to run along each plot (admin-map style) instead
// of horizontal chips that collide.
// 'v9' fix label rotation: out-specify leaflet.css's `.leaflet-marker-icon
// { display:block }` so the label stays a flex/inline-block element that CSS
// transform actually applies to (transform is ignored on display:inline).
// 'v10' /code-review polish: finite-rotation guard, hoist escape map, defer
// popup DOM.
// 'v11' findings now POST to the inspections plugin's own save endpoint (so
// they actually sync); map remembers position; labels scale with zoom.
// 'v12' app.js auto-reloads on SW update (controllerchange) so a deploy applies
// in one reload instead of two.
const VERSION = 'v12';
const SHELL_CACHE = `ami-shell-${VERSION}`;
const RUNTIME_CACHE = `ami-runtime-${VERSION}`;
const TILE_CACHE = `ami-tiles-${VERSION}`;

const PLUGIN_BASE = new URL(self.location.href).pathname.replace(/service-worker\.js.*$/, ''); // .../public/

// Pre-cache the app shell + critical static assets.
const PRECACHE_URLS = [
	'/inspect/',
	`${PLUGIN_BASE}css/inspect.css`,
	`${PLUGIN_BASE}js/app.js`,
	`${PLUGIN_BASE}js/router.js`,
	`${PLUGIN_BASE}js/components/header.js`,
	`${PLUGIN_BASE}js/components/badge.js`,
	`${PLUGIN_BASE}js/pages/round-picker.js`,
	`${PLUGIN_BASE}js/pages/plot-picker.js`,
	`${PLUGIN_BASE}js/pages/plot-map.js`,
	`${PLUGIN_BASE}js/pages/finding-editor.js`,
	`${PLUGIN_BASE}js/services/api.js`,
	`${PLUGIN_BASE}js/services/store.js`,
	`${PLUGIN_BASE}js/services/sync.js`,
	`${PLUGIN_BASE}vendor/leaflet/leaflet.js`,
	`${PLUGIN_BASE}vendor/leaflet/leaflet.css`,
	`${PLUGIN_BASE}manifest.webmanifest`,
	`${PLUGIN_BASE}icons/icon-192.png`,
	`${PLUGIN_BASE}icons/icon-512.png`,
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(SHELL_CACHE)
			.then((cache) => cache.addAll(PRECACHE_URLS).catch((e) => {
				// Don't fail install if a precache fetch fails — assets will still
				// be fetched on first navigation.
				console.warn('SW precache had errors', e);
			}))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(keys
				.filter((k) => k.startsWith('ami-') && !k.endsWith(VERSION))
				.map((k) => caches.delete(k))
			))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;

	const url = new URL(req.url);

	// Navigation: always serve the cached shell so the app can boot offline,
	// then router/client code re-fetches data.
	if (req.mode === 'navigate' && url.pathname.startsWith('/inspect')) {
		event.respondWith(
			(async () => {
				try {
					const fresh = await fetch(req);
					const cache = await caches.open(SHELL_CACHE);
					cache.put('/inspect/', fresh.clone());
					return fresh;
				} catch {
					const cached = await caches.match('/inspect/');
					return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
				}
			})()
		);
		return;
	}

	// admin-ajax.php — network-first with cache fallback for GETs only.
	if (url.pathname.endsWith('/wp-admin/admin-ajax.php') && req.method === 'GET') {
		event.respondWith(
			(async () => {
				try {
					const fresh = await fetch(req);
					const cache = await caches.open(RUNTIME_CACHE);
					cache.put(req, fresh.clone());
					return fresh;
				} catch {
					const cached = await caches.match(req);
					return cached || new Response(JSON.stringify({ success: false, data: { message: 'Offline' } }), {
						status: 503,
						headers: { 'Content-Type': 'application/json' },
					});
				}
			})()
		);
		return;
	}

	// Map tiles (Leaflet / OSM / Esri): stale-while-revalidate, bounded cache.
	if (/(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/.test(url.pathname) && /tile/i.test(url.hostname + url.pathname)) {
		event.respondWith(
			(async () => {
				const cache = await caches.open(TILE_CACHE);
				const cached = await cache.match(req);
				const fetchPromise = fetch(req).then((res) => {
					if (res.ok) cache.put(req, res.clone());
					return res;
				}).catch(() => cached);
				return cached || fetchPromise;
			})()
		);
		return;
	}

	// Plugin static assets: cache-first.
	if (url.pathname.includes('/wp-content/plugins/allotment-manager-inspections/')) {
		event.respondWith(
			caches.match(req).then((cached) => cached || fetch(req).then((res) => {
				if (res.ok) {
					caches.open(SHELL_CACHE).then((cache) => cache.put(req, res.clone()));
				}
				return res;
			}))
		);
		return;
	}
});
