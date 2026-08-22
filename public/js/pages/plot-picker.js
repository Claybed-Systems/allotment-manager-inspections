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
import { normaliseQuery, filterPlots, firstMatch } from '../services/plot-search.js';

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

// Same again for the search term: recording a finding returns here, and an
// inspector working through one tenant's plots should not have to retype their
// name after every save. Kept honest by rendering it back INTO the box — a
// remembered filter the inspector cannot see is a plot list that looks broken.
// roundId -> string.
const lastSearch = {};

// Wait this long after the last keystroke before re-rendering. The Map tab
// rebuilds Leaflet on each render, so searching per-keystroke would tear the
// map down and back up three times for "B15".
const SEARCH_DEBOUNCE_MS = 250;

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

	const filterBar = document.createElement('div');
	filterBar.className = 'ami-filter';
	main.appendChild(filterBar);

	// The search box goes ABOVE the chips (hence insertBefore — filterBar is
	// already in the DOM by here). It is the coarser cut, and on a phone it is
	// what an inspector who already knows the plot number reaches for first.
	let searchQuery = normaliseQuery(lastSearch[round.id]);

	const searchBar = document.createElement('div');
	searchBar.className = 'ami-search';
	const searchInput = document.createElement('input');
	searchInput.type = 'search';
	searchInput.className = 'ami-search__input';
	searchInput.placeholder = s.searchPlaceholder;
	searchInput.setAttribute('aria-label', s.searchPlaceholder);
	searchInput.value = searchQuery;
	// Phones: the plot number is the common case, and it starts with a letter,
	// so no numeric keyboard. Autocorrect on a plot number is actively wrong.
	searchInput.autocapitalize = 'none';
	searchInput.autocomplete = 'off';
	searchInput.spellcheck = false;
	searchBar.appendChild(searchInput);
	main.insertBefore(searchBar, filterBar);

	let searchTimer = null;
	function applySearch(raw) {
		const next = normaliseQuery(raw);
		if (next === searchQuery) return; // e.g. trailing space typed
		searchQuery = next;
		lastSearch[round.id] = searchQuery;
		renderFilterBar();
		(currentView === 'map' ? renderMap : renderList)();
	}
	searchInput.addEventListener('input', () => {
		if (searchTimer) clearTimeout(searchTimer);
		const value = searchInput.value;
		searchTimer = setTimeout(() => {
			searchTimer = null;
			applySearch(value);
		}, SEARCH_DEBOUNCE_MS);
	});
	// Enter means "now", and dismisses the on-screen keyboard so the inspector
	// can see the result they just asked for.
	searchInput.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		if (searchTimer) {
			clearTimeout(searchTimer);
			searchTimer = null;
		}
		applySearch(searchInput.value);
		searchInput.blur();
	});
	// The native clear (×) fires `search`, not `input`, on iOS Safari.
	searchInput.addEventListener('search', () => {
		if (searchTimer) {
			clearTimeout(searchTimer);
			searchTimer = null;
		}
		applySearch(searchInput.value);
	});

	function visiblePlots() {
		const matched = filterPlots(plots, searchQuery);
		if (!selected.size) return matched;
		return matched.filter((p) => selected.has(statusBucket(p)));
	}

	function renderFilterBar() {
		filterBar.innerHTML = '';

		// Counted over the SEARCHED set, not the whole round: with "lovelace"
		// typed, "Non-compliant (12)" would be advertising eleven plots the
		// search has already excluded, and ticking it would show one.
		const searched = filterPlots(plots, searchQuery);
		const counts = {};
		for (const key of STATUS_FILTERS) counts[key] = 0;
		for (const p of searched) {
			const bucket = statusBucket(p);
			if (bucket in counts) counts[bucket]++;
		}

		const all = document.createElement('button');
		all.type = 'button';
		all.className = 'ami-filter__chip' + (selected.size ? '' : ' ami-filter__chip--on');
		all.dataset.filter = '';
		all.textContent = `${s.filterAll} (${searched.length})`;
		filterBar.appendChild(all);

		for (const key of STATUS_FILTERS) {
			// A bucket nothing falls into is left out rather than shown as a dead
			// "(0)" chip: on a phone the row is already scrolled, and an empty
			// bucket is one more thing between the inspector and the one they want.
			//
			// A TICKED chip stays, at "(0)". Now that the counts follow the search,
			// a ticked bucket can empty without the inspector doing anything to the
			// chips — and dropping it would leave an empty list with its cause off
			// screen, which reads as the app being broken rather than as a filter
			// that needs unticking.
			if (!counts[key] && !selected.has(key)) continue;
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
			viewport.innerHTML = `<div class="ami-empty">${escapeHtml(emptyMessage())}</div>`;
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
			viewport.innerHTML = `<div class="ami-empty">${escapeHtml(emptyMessage())}</div>`;
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
				// With a search active the map opens on the lowest-numbered
				// match rather than fitting the whole set: search "Lovelace"
				// and it lands on B15, where they start walking. `shown` is in
				// server order, which IS plot-number order, so "first" is
				// "lowest" without sorting anything here.
				focus: firstMatch(shown, searchQuery),
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

	/**
	 * Why the list is empty — the search, the chips, or both. "No plots match
	 * that filter" while the inspector is staring at a plot number they typed
	 * sends them looking for the wrong thing.
	 */
	function emptyMessage() {
		if (searchQuery && selected.size) return s.searchFilterEmpty;
		if (searchQuery) return s.searchEmpty.replace('%s', searchInput.value.trim());
		return s.filterEmpty;
	}

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
