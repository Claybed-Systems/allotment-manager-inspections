/**
 * Tiny hash-based router.
 *
 * Routes:
 *   #/                       → round picker (default)
 *   #/round/:id              → plot picker for that round
 *   #/round/:id/plot/:plotId → finding editor
 *
 * Renders into a #app element via a `mount(view)` API. Each view module
 * exports a `render(params, ctx) → HTMLElement` function and optionally
 * a `cleanup()` returned by render for teardown.
 */

const routes = [
	{ pattern: /^#?\/?$/,                                                  name: 'roundPicker' },
	{ pattern: /^#?\/?queue\/?$/,                                          name: 'queue' },
	{ pattern: /^#?\/?round\/(\d+)\/?$/,                                   name: 'plotPicker',    params: ['roundId'] },
	{ pattern: /^#?\/?round\/(\d+)\/plot\/(\d+)\/?$/,                      name: 'findingEditor', params: ['roundId', 'plotId'] },
];

let currentCleanup = null;
let viewsRegistry = {};
let mountEl = null;

export function registerViews(views) {
	viewsRegistry = views;
}

export function start(rootEl) {
	mountEl = rootEl;
	window.addEventListener('hashchange', render);
	render();
}

export function navigate(hash) {
	window.location.hash = hash.startsWith('#') ? hash : ('#' + (hash.startsWith('/') ? hash : '/' + hash));
}

function parseRoute() {
	const h = window.location.hash || '#/';
	for (const r of routes) {
		const m = h.match(r.pattern);
		if (m) {
			const params = {};
			(r.params || []).forEach((name, i) => { params[name] = m[i + 1]; });
			return { name: r.name, params };
		}
	}
	return { name: 'notFound', params: {} };
}

async function render() {
	if (typeof currentCleanup === 'function') {
		try { currentCleanup(); } catch (e) { /* swallow */ }
		currentCleanup = null;
	}
	const { name, params } = parseRoute();
	const view = viewsRegistry[name] || viewsRegistry.notFound;
	if (!view) return;
	try {
		const result = await view.render(params, { mount: mountEl, navigate });
		if (typeof result === 'function') currentCleanup = result;
	} catch (e) {
		console.error('Render failed', e);
		mountEl.innerHTML = `<div class="ami-main"><div class="ami-error">${e.message || 'Failed to load'}</div></div>`;
	}
	window.scrollTo(0, 0);
}
