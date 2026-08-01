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

// Remember the inspector's last List/Map choice per round. Returning from a
// finding navigates back to /round/:id and re-renders this picker; without this
// the picker always reopened on List, so an inspector working from the Map had
// to re-tap "Map" after every plot. The map itself already restores its
// centre+zoom (plot-map.js `savedView`); this restores the tab. Module-scoped
// so it survives the SPA re-render.
const lastView = {}; // roundId -> 'list' | 'map'

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

	// Reopen the tab the inspector last used for this round (default List).
	const initialView = lastView[round.id] === 'map' ? 'map' : 'list';

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

	// Progress counts only the plots this round actually re-inspects. On a
	// follow-up the list also carries the rest of the section, faded, so the
	// inspector can orient themselves — counting those would put the whole
	// section back in the denominator, which is the bug fixed twice already
	// (ams#850, ams#860). `inScope` is undefined on a cached response from
	// before this change; treat that as in-scope so an old payload still shows
	// the progress it always did.
	const scoped = plots.filter((p) => p.inScope !== false);
	const inspected = scoped.filter((p) => p.currentFindingId).length;
	const progress = document.createElement('div');
	progress.style.marginBottom = '12px';
	progress.innerHTML = `
		<div class="ami-card__detail">${s.progress.replace('%d', inspected).replace('%d', scoped.length)}</div>
		<div class="ami-progress-bar"><div class="ami-progress-bar__fill" style="width:${scoped.length ? Math.round((inspected / scoped.length) * 100) : 0}%"></div></div>
	`;
	main.appendChild(progress);

	// Tabs
	const tabs = document.createElement('div');
	tabs.className = 'ami-tabs';
	tabs.innerHTML = `
		<button type="button" class="ami-tabs__btn${initialView === 'list' ? ' ami-tabs__btn--active' : ''}" data-view="list">${s.list}</button>
		<button type="button" class="ami-tabs__btn${initialView === 'map' ? ' ami-tabs__btn--active' : ''}" data-view="map">${s.map}</button>
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
			viewport.innerHTML = `<div class="ami-empty">No plots in this section yet.</div>`;
			return;
		}

		// On a follow-up, say up front how many of the listed plots actually need
		// re-inspecting — the list is now mostly context, so the count is not
		// something the inspector can read off its length any more.
		if (round.inspectionType === 'followup') {
			const note = document.createElement('div');
			note.className = 'ami-scope-note';
			note.textContent = scoped.length
				? `${scoped.length} plot${scoped.length === 1 ? '' : 's'} to re-inspect. The rest are shown faded, for orientation.`
				: 'No plots from the first round need a follow-up. The section is shown for reference.';
			viewport.appendChild(note);
		}

		for (const p of plots) {
			const isVacant = !!p.isVacant;
			// Out of scope: on a follow-up round, a plot the first round passed. It
			// is listed so the inspector can place themselves while walking, but it
			// is not being re-inspected — so it is not recordable, and the server
			// refuses a finding on it regardless of what the UI allows.
			const outOfScope = p.inScope === false;
			// Neither vacant nor out-of-scope plots are inspectable: a plain div
			// (no button, no navigation) so the inspector sees the plot without
			// being able to open a finding the server would reject.
			const inert = isVacant || outOfScope;
			const row = document.createElement(inert ? 'div' : 'button');
			row.className = 'ami-plot-row'
				+ (outOfScope ? ' ami-plot-row--out-of-scope' : '')
				+ (isVacant ? ' ami-plot-row--vacant' : '');
			if (!inert) {
				row.type = 'button';
				row.onclick = () => navigate(`/round/${round.id}/plot/${p.id}`);
			}

			const newChip = p.isNewTenant ? '<span class="ami-chip ami-chip--new">New</span>' : '';
			// Out of scope wins the trailing slot: "Passed" explains why the row is
			// inert, where a category badge would read as this round's result.
			const trailing = outOfScope
				? '<span class="ami-chip ami-chip--passed">Passed</span>'
				: isVacant
					? '<span class="ami-chip ami-chip--vacant">Vacant</span>'
					: badge(p.currentCategory);

			row.innerHTML = `
				<span class="ami-plot-row__number">${escapeHtml(p.plotNumber)}</span>
				<span class="ami-plot-row__name${p.tenantName ? '' : ' ami-plot-row__name__empty'}">
					${escapeHtml(p.tenantName || 'Vacant')}${newChip}
				</span>
				${trailing}
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
		lastView[round.id] = btn.dataset.view;
		(btn.dataset.view === 'map' ? renderMap : renderList)();
	});

	// Open the remembered tab (default List). initialView was derived from
	// lastView[round.id] above, and the tab-click handler is its only writer.
	(initialView === 'map' ? renderMap : renderList)();
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
