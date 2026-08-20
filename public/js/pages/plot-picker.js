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
import { badgeMeta, statusBucket } from '../components/badge.js';

const s = window.amiData.strings;

// Remember the inspector's last List/Map choice per round. Returning from a
// finding navigates back to /round/:id and re-renders this picker; without this
// the picker always reopened on List, so an inspector working from the Map had
// to re-tap "Map" after every plot. The map itself already restores its
// centre+zoom (plot-map.js `savedView`); this restores the tab. Module-scoped
// so it survives the SPA re-render.
const lastView = {}; // roundId -> 'list' | 'map'

// The buckets a plot can fall into, in the order the website's round screen
// lists them, so an inspector reading both screens reads the same vocabulary.
// `none` is not a compliance_status — it is the plots with no finding in this
// round, which on a half-walked round is most of them.
const STATUS_FILTERS = [
	'non_compliant',
	'compliant',
	'exempt',
	'new_tenant',
	'internal_review',
	'none',
];

// Remember the ticked filter per round, for the same reason lastView exists:
// returning from a finding re-renders this picker, and an inspector working
// the non-compliant plots should not have to re-tick after every save.
// Module-scoped so it survives the SPA re-render. roundId -> Set<string>.
const lastFilter = {};

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

	mount.appendChild(renderHeader({
		title: round.roundNumber,
		subtitle: round.siteSection,
		showBack: true,
		onBack: () => navigate('/'),
	}));

	const main = document.createElement('main');
	main.className = 'ami-main';
	mount.appendChild(main);

	// A round covers its whole section (#883), so the denominator is simply the
	// section — there is no longer a re-inspected subset to count against, and
	// no faded remainder to keep out of it.
	//
	// Progress is deliberately NOT the filter's business: it reports the round,
	// so filtering to the non-compliant plots must not make the round look
	// nearly done. It reads `plots`, never visiblePlots().
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
		<button type="button" class="ami-tabs__btn${initialView === 'list' ? ' ami-tabs__btn--active' : ''}" data-view="list">${s.list}</button>
		<button type="button" class="ami-tabs__btn${initialView === 'map' ? ' ami-tabs__btn--active' : ''}" data-view="map">${s.map}</button>
	`;
	main.appendChild(tabs);

	// ---- Filter -------------------------------------------------------------
	// The ticked buckets. Nothing ticked means no filter — every plot shows —
	// so an inspector who has never touched the chips sees the round exactly as
	// they always did.
	const selected = new Set(lastFilter[round.id] || []);

	const counts = {};
	for (const key of STATUS_FILTERS) counts[key] = 0;
	for (const p of plots) {
		const bucket = statusBucket(p);
		if (bucket in counts) counts[bucket]++;
	}

	const filterBar = document.createElement('div');
	filterBar.className = 'ami-filter';
	main.appendChild(filterBar);

	function visiblePlots() {
		if (!selected.size) return plots;
		return plots.filter((p) => selected.has(statusBucket(p)));
	}

	function renderFilterBar() {
		filterBar.innerHTML = '';

		const all = document.createElement('button');
		all.type = 'button';
		all.className = 'ami-filter__chip' + (selected.size ? '' : ' ami-filter__chip--on');
		all.dataset.filter = '';
		all.textContent = `${s.filterAll} (${plots.length})`;
		filterBar.appendChild(all);

		for (const key of STATUS_FILTERS) {
			// A bucket nothing falls into is left out rather than shown as a dead
			// "(0)" chip: on a phone the row is already scrolled, and an empty
			// bucket is one more thing between the inspector and the one they want.
			// It cannot hide a ticked chip — ticking requires a non-zero count, and
			// a bucket that empties while the screen is open would need a save,
			// which re-renders the picker from a fresh payload anyway.
			if (!counts[key]) continue;
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'ami-filter__chip ami-filter__chip--' + key.replace(/_/g, '-')
				+ (selected.has(key) ? ' ami-filter__chip--on' : '');
			chip.dataset.filter = key;
			chip.setAttribute('aria-pressed', selected.has(key) ? 'true' : 'false');
			chip.textContent = `${filterLabel(key)} (${counts[key]})`;
			filterBar.appendChild(chip);
		}
	}

	filterBar.addEventListener('click', (e) => {
		const chip = e.target.closest('.ami-filter__chip');
		if (!chip) return;
		const key = chip.dataset.filter;
		if (!key) {
			selected.clear();
		} else if (selected.has(key)) {
			selected.delete(key);
		} else {
			selected.add(key);
		}
		lastFilter[round.id] = [...selected];
		renderFilterBar();
		// Re-render whichever view is showing, so List and Map never disagree
		// about which plots the inspector asked to see.
		(currentView === 'map' ? renderMap : renderList)();
	});

	renderFilterBar();

	const viewport = document.createElement('div');
	main.appendChild(viewport);

	// Map lifecycle: tear the Leaflet instance down whenever we leave the Map
	// tab, and invalidate an in-flight async map render by bumping the token —
	// so a slow Leaflet load can't clobber the List after the user toggles.
	let mapHandle = null;
	let mapToken = 0;
	// Which view is showing. The filter re-renders it in place, so it needs to
	// know which one without asking the DOM.
	let currentView = initialView;
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

		const shown = visiblePlots();
		if (!shown.length) {
			viewport.innerHTML = `<div class="ami-empty">${escapeHtml(s.filterEmpty)}</div>`;
			return;
		}

		for (const p of shown) {
			// A vacant plot is shown but not inspectable — there is no tenant to
			// record against and create_finding would reject it — so it renders as
			// a plain div, with no button and no navigation.
			const isVacant = !!p.isVacant;
			const row = document.createElement(isVacant ? 'div' : 'button');
			row.className = 'ami-plot-row' + (isVacant ? ' ami-plot-row--vacant' : '');
			if (!isVacant) {
				row.type = 'button';
				row.onclick = () => navigate(`/round/${round.id}/plot/${p.id}`);
			}

			const newChip = p.isNewTenant ? '<span class="ami-chip ami-chip--new">New</span>' : '';
			const trailing = isVacant
				? '<span class="ami-chip ami-chip--vacant">Vacant</span>'
				: badge(p.currentCategory, p.currentStatus);

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

		const shown = visiblePlots();
		if (plots.length && !shown.length) {
			viewport.innerHTML = `<div class="ami-empty">${escapeHtml(s.filterEmpty)}</div>`;
			return;
		}

		const host = document.createElement('div');
		viewport.appendChild(host);

		let handle;
		try {
			const mod = await import('./plot-map.js');
			if (token !== mapToken) return; // toggled away while importing
			handle = await mod.renderPlotMap(host, {
				round,
				plots: shown,
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
		currentView = btn.dataset.view;
		(currentView === 'map' ? renderMap : renderList)();
	});

	// Open the remembered tab (default List). initialView was derived from
	// lastView[round.id] above, and the tab-click handler is its only writer.
	(initialView === 'map' ? renderMap : renderList)();
}

function badge(category, status) {
	const [cls, label] = badgeMeta(category, s, status);
	return `<span class="ami-badge ${cls}">${label}</span>`;
}

/**
 * Chip label for a filter bucket. Same wording as the website's round screen,
 * except that the field app says "Pass" where the website says "Compliant" —
 * "Pass" is what the inspector taps when recording, so it is the word they
 * already have in hand.
 */
function filterLabel(key) {
	const labels = {
		non_compliant:   s.statusNonCompliant,
		compliant:       s.cat1,
		exempt:          s.statusExempt,
		new_tenant:      s.statusNewTenant,
		internal_review: s.statusUnderReview,
		none:            s.notInspected,
	};
	return labels[key] || key;
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = String(str ?? '');
	return div.innerHTML;
}
