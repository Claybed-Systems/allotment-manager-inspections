/**
 * Finding editor — /inspect/#/round/:roundId/plot/:plotId
 *
 * The actual inspection-recording screen. Lets the inspector:
 *   - See plot number, tenant, existing photos
 *   - Take photos (native camera via <input capture>)
 *   - Type notes
 *   - Pick a rating: 1 Pass / 2 Minor / 3 Major
 *   - Save (online → POST + photo uploads; offline → queue both)
 */

import * as api from '../services/api.js';
import * as store from '../services/store.js';
import * as sync from '../services/sync.js';
import { renderHeader } from '../components/header.js';

const s = window.amiData.strings;

export async function render({ roundId, plotId }, { mount, navigate }) {
	mount.innerHTML = '';
	roundId = parseInt(roundId, 10);
	plotId = parseInt(plotId, 10);

	let data;
	try {
		data = await api.getPlot(roundId, plotId);
	} catch (e) {
		mount.appendChild(renderHeader({ title: 'Plot', showBack: true, onBack: () => navigate('/round/' + roundId) }));
		const m = document.createElement('main');
		m.className = 'ami-main';
		m.innerHTML = `<div class="ami-error">${escapeHtml(e.message)}</div>`;
		mount.appendChild(m);
		return;
	}

	const plot = data.plot;
	const existing = data.finding;
	const existingPhotos = data.photos || [];

	// A new finding is always editable; an existing one only by a recorded
	// inspector or the chair/admin (the server returns canEdit accordingly and
	// re-checks on save — this just drives the UI).
	const canEditFinding = !existing || existing.canEdit !== false;

	const state = {
		rating: existing ? categoryToRating(existing.complianceCategory) : null,
		notes: existing ? (existing.findingsSummary || '') : '',
		// Issue tickboxes (DB 2.11.2). Each key is `null` (not assessed
		// this round), `false` (inspector explicitly recorded no issue)
		// or `true` (issue ticked). The api layer only forwards keys
		// that are NOT null, preserving the schema's tri-state on the
		// server. Pre-populate from any existing finding so reopening
		// the page after a save shows the previously-recorded state.
		issues: {
			has_rubbish:             existing && existing.hasRubbish !== undefined ? !!existing.hasRubbish : null,
			has_overgrown_weeds:     existing && existing.hasOvergrownWeeds !== undefined ? !!existing.hasOvergrownWeeds : null,
			has_uncultivated_areas:  existing && existing.hasUncultivatedAreas !== undefined ? !!existing.hasUncultivatedAreas : null,
			has_derelict_structures: existing && existing.hasDerelictStructures !== undefined ? !!existing.hasDerelictStructures : null,
			has_tenancy_breach:      existing && existing.hasTenancyBreach !== undefined ? !!existing.hasTenancyBreach : null,
			tenancy_breach_description: existing && existing.tenancyBreachDescription ? existing.tenancyBreachDescription : '',
		},
		newPhotos: [], // { blob, url, filename }
	};

	mount.appendChild(renderHeader({
		title: 'Plot ' + plot.plotNumber,
		subtitle: plot.tenantName || 'Vacant',
		showBack: true,
		onBack: () => navigate('/round/' + roundId),
	}));

	const main = document.createElement('main');
	main.className = 'ami-main ami-finding';
	mount.appendChild(main);

	// Existing finding: show who recorded it + the edit affordance / warning.
	if (existing) {
		const banner = document.createElement('div');
		banner.className = 'ami-edit-banner' + (canEditFinding ? '' : ' ami-edit-banner--readonly');
		let html = '<strong>Existing inspection</strong>';
		if (existing.recordedBy) html += ' · recorded by ' + escapeHtml(existing.recordedBy);
		if (existing.edited) html += ' · <em>edited</em>';
		html += '<br>';
		if (!canEditFinding) {
			html += 'Only the inspector who recorded this, or the chair, can change it.';
		} else if (existing.hasNotice) {
			html += '⚠ A notice has already been sent for this plot — editing the result here will <strong>not</strong> change that notice.';
		} else {
			html += 'You can correct this result below, then tap Update finding.';
		}
		banner.innerHTML = html;
		main.appendChild(banner);
	}

	// --- Photos ---
	const photoLabel = document.createElement('label');
	photoLabel.className = 'ami-label';
	photoLabel.textContent = 'Photos';
	main.appendChild(photoLabel);

	const grid = document.createElement('div');
	grid.className = 'ami-photo-grid';
	main.appendChild(grid);

	function renderPhotos() {
		grid.innerHTML = '';
		for (const p of existingPhotos) {
			const cell = document.createElement('div');
			cell.className = 'ami-photo';
			cell.innerHTML = `<img src="${escapeAttr(p.thumbnailUrl || p.url)}" alt="${escapeAttr(p.caption || 'Photo')}">`;
			grid.appendChild(cell);
		}
		for (const p of state.newPhotos) {
			const cell = document.createElement('div');
			cell.className = 'ami-photo ami-photo--pending';
			cell.innerHTML = `<img src="${p.url}" alt=""><span class="ami-photo__queue-tag">new</span>`
				+ `<button type="button" class="ami-photo__delete" aria-label="Remove photo">&times;</button>`;
			cell.querySelector('.ami-photo__delete').addEventListener('click', () => {
				URL.revokeObjectURL(p.url);
				const i = state.newPhotos.indexOf(p);
				if (i !== -1) state.newPhotos.splice(i, 1);
				renderPhotos();
			});
			grid.appendChild(cell);
		}

		// "Take photo" tile
		const add = document.createElement('label');
		add.className = 'ami-photo-add';
		add.innerHTML = `
			<span class="ami-photo-add__icon">📷</span>
			<span>${s.takePhoto}</span>
			<input type="file" accept="image/*" capture="environment" />
		`;
		add.querySelector('input').addEventListener('change', onPickPhoto);
		grid.appendChild(add);
	}

	async function onPickPhoto(e) {
		const file = e.target.files && e.target.files[0];
		e.target.value = ''; // allow re-picking same file later
		if (!file) return;

		// Lightly downscale to avoid 5-MB photos. Server-side WP will re-scale
		// further, but we do a sensible initial pass to make queued blobs smaller.
		const blob = await downscale(file, 2048, 0.85);
		const url = URL.createObjectURL(blob);
		state.newPhotos.push({ blob, url, filename: file.name || `photo-${Date.now()}.jpg` });
		renderPhotos();
	}

	renderPhotos();

	// --- Notes ---
	const notesLabel = document.createElement('label');
	notesLabel.className = 'ami-label';
	notesLabel.htmlFor = 'ami-notes';
	notesLabel.textContent = s.notes;
	main.appendChild(notesLabel);

	const notes = document.createElement('textarea');
	notes.className = 'ami-textarea';
	notes.id = 'ami-notes';
	notes.placeholder = 'Anything to remember about this plot…';
	notes.value = state.notes;
	notes.addEventListener('input', () => { state.notes = notes.value; });
	main.appendChild(notes);

	// --- Rating ---
	const ratingLabel = document.createElement('label');
	ratingLabel.className = 'ami-label';
	ratingLabel.textContent = 'Rating';
	main.appendChild(ratingLabel);

	const rating = document.createElement('div');
	rating.className = 'ami-rating';
	rating.innerHTML = `
		<button type="button" class="ami-rating__btn ami-rating__btn--1" data-rating="1">
			<span class="ami-rating__num">1</span>
			<span>${s.pass}</span>
		</button>
		<button type="button" class="ami-rating__btn ami-rating__btn--2" data-rating="2">
			<span class="ami-rating__num">2</span>
			<span>${s.minor}</span>
		</button>
		<button type="button" class="ami-rating__btn ami-rating__btn--3" data-rating="3">
			<span class="ami-rating__num">3</span>
			<span>${s.major}</span>
		</button>
	`;
	main.appendChild(rating);

	function refreshRatingUI() {
		[...rating.children].forEach((btn) => {
			const n = parseInt(btn.dataset.rating, 10);
			btn.classList.toggle('ami-rating__btn--selected', n === state.rating);
		});
		// saveBtn is null in the read-only case (existing finding the user may
		// not edit) — the save bar renders a note instead of a button.
		if (saveBtn) saveBtn.disabled = !state.rating;
	}

	rating.addEventListener('click', (e) => {
		const btn = e.target.closest('.ami-rating__btn');
		if (!btn) return;
		state.rating = parseInt(btn.dataset.rating, 10);
		refreshRatingUI();
	});

	// --- Issues observed ---
	// Tick what's wrong (or right). Section maps to the committee's
	// Site Inspection Procedure v3.0 issue list — Cat 2 (some rubbish /
	// weeds / minor tenancy breach) vs Cat 3 (significant versions +
	// derelict structures + essentially no cultivation). Severity is
	// the Rating above; these flags structure the WHY so reports can
	// pivot by issue type instead of grepping prose.
	//
	// Each tickbox starts "not assessed" (null) and toggles between
	// "ticked" (true) and "not ticked but recorded" (false) on click.
	// Three-state UI: empty / ✓ / ✗ — but for first-cut simplicity we
	// stick to binary unchecked/checked, and the api layer translates
	// "left unchecked = null" the first time, "explicitly unchecked
	// after touching = false" on re-saves.
	const issuesLabel = document.createElement('label');
	issuesLabel.className = 'ami-label';
	issuesLabel.textContent = s.issuesObserved || 'Issues observed';
	main.appendChild(issuesLabel);

	const issuesList = document.createElement('div');
	issuesList.className = 'ami-issues';

	const issueDefs = [
		{ key: 'has_rubbish',             label: s.issueRubbish             || 'Non-compostable rubbish' },
		{ key: 'has_overgrown_weeds',     label: s.issueOvergrownWeeds      || 'Long grass or overgrown weeds' },
		{ key: 'has_uncultivated_areas',  label: s.issueUncultivated        || 'Essentially no cultivation' },
		{ key: 'has_derelict_structures', label: s.issueDerelictStructures  || 'Derelict sheds / greenhouses' },
		{ key: 'has_tenancy_breach',      label: s.issueTenancyBreach       || 'Tenancy agreement breach' },
	];

	for (const def of issueDefs) {
		const row = document.createElement('label');
		row.className = 'ami-issue';
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.dataset.issue = def.key;
		cb.checked = !!state.issues[def.key];
		cb.addEventListener('change', () => {
			state.issues[def.key] = cb.checked;
			if (def.key === 'has_tenancy_breach') {
				breachDetailRow.style.display = cb.checked ? '' : 'none';
				if (!cb.checked) {
					state.issues.tenancy_breach_description = '';
					breachInput.value = '';
				}
			}
		});
		const txt = document.createElement('span');
		txt.textContent = def.label;
		row.appendChild(cb);
		row.appendChild(txt);
		issuesList.appendChild(row);
	}
	main.appendChild(issuesList);

	// Tenancy breach detail field — revealed only when the breach
	// tickbox is on. Max 255 chars (matches schema column width).
	const breachDetailRow = document.createElement('div');
	breachDetailRow.className = 'ami-issue-detail';
	breachDetailRow.style.display = state.issues.has_tenancy_breach ? '' : 'none';
	const breachLabel = document.createElement('label');
	breachLabel.className = 'ami-label';
	breachLabel.htmlFor = 'ami-breach-detail';
	breachLabel.textContent = s.tenancyBreachDetailLabel || 'Briefly describe the breach';
	const breachInput = document.createElement('input');
	breachInput.type = 'text';
	breachInput.id = 'ami-breach-detail';
	breachInput.className = 'ami-input';
	breachInput.maxLength = 255;
	breachInput.placeholder = s.tenancyBreachDetailPlaceholder || 'e.g. subletting, structural change without consent';
	breachInput.value = state.issues.tenancy_breach_description || '';
	breachInput.addEventListener('input', () => {
		state.issues.tenancy_breach_description = breachInput.value;
	});
	breachDetailRow.appendChild(breachLabel);
	breachDetailRow.appendChild(breachInput);
	main.appendChild(breachDetailRow);

	// --- Sticky save bar ---
	const saveBar = document.createElement('div');
	saveBar.className = 'ami-save-bar';
	if (canEditFinding) {
		const label = existing ? 'Update finding' : s.save;
		saveBar.innerHTML = `<button type="button" class="ami-btn" id="ami-save">${escapeHtml(label)}</button>`;
	} else {
		saveBar.innerHTML = `<div class="ami-save-readonly">Read-only — you can’t change this finding.</div>`;
	}
	mount.appendChild(saveBar);
	const saveBtn = saveBar.querySelector('#ami-save');

	refreshRatingUI();

	if (saveBtn) saveBtn.addEventListener('click', async () => {
		const isEdit = !!(existing && existing.id);

		// Warn-and-allow before changing a recorded result; edits are online-only.
		if (isEdit) {
			const msg = existing.hasNotice
				? 'A notice has already been sent for this plot based on the original result. Editing the finding will NOT change that notice. Continue anyway?'
				: 'You are changing a recorded inspection result. The change is logged. Continue?';
			if (!window.confirm(msg)) return;
			if (!navigator.onLine) {
				window.alert('You need to be online to change an existing finding.');
				return;
			}
		}

		saveBtn.disabled = true;
		saveBtn.textContent = '…';

		let findingId = existing ? existing.id : null;

		try {
			if (isEdit) {
				// Edit an existing finding (online only — not queued).
				await api.updateFinding({
					findingId: existing.id,
					rating: state.rating,
					notes: state.notes,
					issues: state.issues,
				});
				findingId = existing.id;
			} else if (navigator.onLine) {
				const result = await api.saveFinding({
					roundId,
					plotId,
					memberId: plot.memberId,
					rating: state.rating,
					notes: state.notes,
					issues: state.issues,
				});
				findingId = (result && (result.finding_id || result.id)) || findingId;
			} else {
				// Queue a NEW finding locally (offline). issues is included so a
				// later sync sends it on to api.saveFinding verbatim. Photos get
				// tagged with the pending row's id for re-assignment after sync.
				const pending = await store.queueFinding({
					roundId, plotId, memberId: plot.memberId, rating: state.rating, notes: state.notes,
					issues: state.issues,
				});
				for (const ph of state.newPhotos) {
					await store.queuePhoto({ pendingFindingId: pending.id, blob: ph.blob, filename: ph.filename });
				}
				state.newPhotos = [];
				sync.syncOnce();
				navigate('/round/' + roundId);
				return;
			}

			// Upload any newly-added photos now we have a real finding id.
			for (const ph of state.newPhotos) {
				try {
					await api.uploadPhoto({ findingId, blob: ph.blob, filename: ph.filename });
				} catch (e) {
					await store.queuePhoto({ findingId, blob: ph.blob, filename: ph.filename });
				}
			}
			state.newPhotos = [];

			sync.syncOnce();
			navigate('/round/' + roundId);
		} catch (e) {
			if (isEdit) {
				// Edits are not queued — surface the reason and let them retry.
				saveBtn.disabled = false;
				saveBtn.textContent = 'Update finding';
				window.alert('Couldn’t save the change: ' + ((e && e.message) ? e.message : 'unknown error'));
				return;
			}
			// New finding failed online — queue and bail to the round view.
			console.warn('Save failed, queueing', e);
			const pending = await store.queueFinding({
				roundId, plotId, memberId: plot.memberId, rating: state.rating, notes: state.notes,
				issues: state.issues,
			});
			for (const ph of state.newPhotos) {
				await store.queuePhoto({ pendingFindingId: pending.id, blob: ph.blob, filename: ph.filename });
			}
			alert(s.saveError);
			navigate('/round/' + roundId);
		}
	});
}

// ---- Helpers ----

function categoryToRating(cat) {
	if (cat === 'category_1') return 1;
	if (cat === 'category_2') return 2;
	if (cat === 'category_3') return 3;
	return null;
}

async function downscale(file, maxSize, quality) {
	// If the file is small or not an image, return as-is.
	if (!file.type.startsWith('image/')) return file;
	if (file.size < 500_000) return file;
	const img = await loadImage(file);
	const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
	if (scale === 1) return file;
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(img.width * scale);
	canvas.height = Math.round(img.height * scale);
	const ctx = canvas.getContext('2d');
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function loadImage(file) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const url = URL.createObjectURL(file);
		img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
		img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
		img.src = url;
	});
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = String(str ?? '');
	return div.innerHTML;
}
function escapeAttr(str) {
	return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
