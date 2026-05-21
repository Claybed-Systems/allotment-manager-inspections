/**
 * App entry — wires up the router, registers views, starts the sync loop and
 * registers the service worker.
 */

import { registerViews, start } from './router.js';
import * as roundPicker from './pages/round-picker.js';
import * as plotPicker from './pages/plot-picker.js';
import * as findingEditor from './pages/finding-editor.js';
import { startAutoSync } from './services/sync.js';

const notFound = {
	render(_params, { mount }) {
		mount.innerHTML = `
			<header class="ami-header"><h1 class="ami-header__title">Not found</h1></header>
			<main class="ami-main">
				<div class="ami-empty">That page does not exist. <a href="#/">Back to rounds</a>.</div>
			</main>
		`;
	},
};

registerViews({
	roundPicker,
	plotPicker,
	findingEditor,
	notFound,
});

const root = document.getElementById('app');
if (root) start(root);

startAutoSync();

// Register service worker. The SW must live at a URL whose path is a prefix
// of /inspect/* — we serve it via a rewrite (see Plugin route). For now, use
// the absolute plugin URL with `scope: '/inspect/'`, which the SW manifest
// header authorises via `Service-Worker-Allowed`.
if ('serviceWorker' in navigator) {
	const swUrl = (window.amiData.pluginUrl || '/') + 'public/service-worker.js?ver=' + (window.amiData.version || '1');
	navigator.serviceWorker.register(swUrl, { scope: '/inspect/' })
		.then(() => console.info('Inspector SW registered'))
		.catch((err) => console.warn('Inspector SW failed to register (PWA may not work offline)', err));
}
