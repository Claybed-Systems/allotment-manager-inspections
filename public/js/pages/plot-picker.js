/**
 * Plot picker — /inspect/#/round/:roundId
 *
 * Two views, toggled by tabs at the top:
 *   - List (default): each row = plot number + tenant name + status badge
 *   - Map: Leaflet map with plot polygons coloured by status (deferred to v2)
 *
 * For v1, "Map" tab is shown but renders a placeholder that tells the user
 * the polygon data must be set up first. We keep the toggle so the UI is
 * complete and the map view can be filled in later by extending this file.
 */

import * as api from '../services/api.js';
import { renderHeader } from '../components/header.js';
import { badgeMeta } from '../components/badge.js';

const s = window.amiData.strings;

export async function render({ roundId }, { mount, navigate }) {
	mount.innerHTML = '';
	roundId = parseInt(roundId, 10);

	let data;
	try {
		data = await api.listPlots(roundId);
	} catch (e) {
		mount.appendChild(renderHeader({ title: 'Round', showBack: true, onBack: () => navigate('/') }));
		const m = document.createElement('main');
		m.className = 'ami-main';
		m.innerHTML = `<div class="ami-error">${escapeHtml(e.message)}</div>`;
		mount.appendChild(m);
		return;
	}

	const round = data.round;
	const plots = data.plots || [];

	const typeLabel = round.inspectionType === 'followup' ? 'Follow-up' : 'First round';

	mount.appendChild(renderHeader({
		title: round.roundNumber,
		subtitle: `${typeLabel} · ${round.siteSection}`,
		showBack: true,
		onBack: () => navigate('/'),
	}));

	const main = document.createElement('main');
	main.className = 'ami-main';
	mount.appendChild(main);

	// Progress
	const inspected = plots.filter((p) => p.currentFindingId).length;
	const progress = document.createElement('div');
	progress.style.marginBottom = '12px';
	progress.innerHTML = `
		<div class="ami-card__detail">${s.progress.replace('%d', inspected).replace('%d', plots.length)}</div>
		<div class="ami-progress-bar"><div class="ami-progress-bar__fill" style="width:${plots.length ? Math.round((inspected / plots.length) * 100) : 0}%"></div></div>
	`;
	main.appendChild(progress);

	// Tabs
	const tabs = document.createElement('div');
	tabs.className = 'ami-tabs';
	tabs.innerHTML = `
		<button type="button" class="ami-tabs__btn ami-tabs__btn--active" data-view="list">${s.list}</button>
		<button type="button" class="ami-tabs__btn" data-view="map">${s.map}</button>
	`;
	main.appendChild(tabs);

	const viewport = document.createElement('div');
	main.appendChild(viewport);

	// Map lifecycle: tear the Leaflet instance down whenever we leave the Map
	// tab, and invalidate an in-flight async map render by bumping the token —
	// so a slow Leaflet load can't clobber the List after the user toggles.
	let mapHandle = null;
	let mapToken = 0;
	function teardownMap() {
		if (mapHandle) {
			mapHandle.destroy();
			mapHandle = null;
		}
	}

	function renderList() {
		teardownMap();
		mapToken++;
		viewport.innerHTML = '';
		if (!plots.length) {
			viewport.innerHTML = `<div class="ami-empty">${
				round.inspectionType === 'followup'
					? 'No plots from the parent round need a follow-up. Great work!'
					: 'No plots in this section yet.'
			}</div>`;
			return;
		}
		for (const p of plots) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'ami-plot-row';
			row.onclick = () => navigate(`/round/${round.id}/plot/${p.id}`);

			row.innerHTML = `
				<span class="ami-plot-row__number">${escapeHtml(p.plotNumber)}</span>
				<span class="ami-plot-row__name${p.tenantName ? '' : ' ami-plot-row__name__empty'}">
					${escapeHtml(p.tenantName || 'Vacant')}
				</span>
				${badge(p.currentCategory)}
			`;
			viewport.appendChild(row);
		}
	}

	async function renderMap() {
		teardownMap();
		const token = ++mapToken;
		viewport.innerHTML = '';
		const host = document.createElement('div');
		viewport.appendChild(host);

		let handle;
		try {
			const mod = await import('./plot-map.js');
			if (token !== mapToken) return; // toggled away while importing
			handle = await mod.renderPlotMap(host, {
				round,
				plots,
				tile: (data.map || {}).tile,
				navigate,
				strings: s,
			});
		} catch (err) {
			if (token === mapToken) {
				host.innerHTML = '';
				const box = document.createElement('div');
				box.className = 'ami-error';
				box.textContent = (err && err.message) || 'Could not load the map.';
				host.appendChild(box);
			}
			return;
		}

		if (token !== mapToken) {
			handle.destroy(); // toggled away while rendering
			return;
		}
		mapHandle = handle;
	}

	tabs.addEventListener('click', (e) => {
		const btn = e.target.closest('.ami-tabs__btn');
		if (!btn) return;
		[...tabs.children].forEach((b) => b.classList.toggle('ami-tabs__btn--active', b === btn));
		(btn.dataset.view === 'map' ? renderMap : renderList)();
	});

	renderList();
}

function badge(category) {
	const [cls, label] = badgeMeta(category, s);
	return `<span class="ami-badge ${cls}">${label}</span>`;
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = String(str ?? '');
	return div.innerHTML;
}
