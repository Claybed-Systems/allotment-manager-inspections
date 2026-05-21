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

	function renderList() {
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

	function renderMap() {
		viewport.innerHTML = `
			<div class="ami-empty">
				<p><strong>Map view coming soon.</strong></p>
				<p>The plot polygons need to be set up in the admin's <em>Map Editor</em> before the map can render them. For now, use the list view.</p>
			</div>
		`;
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
	if (!category) return `<span class="ami-badge ami-badge--none">${s.notInspected}</span>`;
	const map = {
		category_1: ['ami-badge--cat1', s.cat1],
		category_2: ['ami-badge--cat2', s.cat2],
		category_3: ['ami-badge--cat3', s.cat3],
	};
	const m = map[category] || ['ami-badge--none', category];
	return `<span class="ami-badge ${m[0]}">${m[1]}</span>`;
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = String(str ?? '');
	return div.innerHTML;
}
