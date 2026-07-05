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

	// Vacant plots are not inspectable — there's no tenant, and the server
	// requires a member to record a finding (it would fail + stick in the
	// queue). The list/map already make vacant plots non-tappable; this guards
	// the direct-URL case. An existing finding (recorded before they left) is
	// still shown so it can be viewed/corrected.
	if (plot.isVacant && !existing) {
		mount.appendChild(renderHeader({
			title: 'Plot ' + plot.plotNumber,
			subtitle: 'Vacant',
			showBack: true,
			onBack: () => navigate('/round/' + roundId),
		}));
		const vm = document.createElement('main');
		vm.className = 'ami-main';
		vm.innerHTML = '<div class="ami-empty"><p><strong>This plot is vacant.</strong></p>'
			+ '<p>There’s no current tenant, so there’s nothing to inspect. '
			+ 'If you believe someone holds this plot, ask the committee to check its tenancy record.</p></div>';
		mount.appendChild(vm);
		return;
	}

	// The inspector can't inspect their OWN plot — the server's self-inspection
	// guard rejects it ("Committee members cannot inspect their own plots"), so
	// recording here would only fail and stick in the sync queue. Show a clear
	// stop instead. An existing finding (recorded by someone else) is still shown
	// so it can be viewed.
	if (plot.isOwnPlot && !existing) {
		mount.appendChild(renderHeader({
			title: 'Plot ' + plot.plotNumber,
			subtitle: 'Your plot',
			showBack: true,
			onBack: () => navigate('/round/' + roundId),
		}));
		const om = document.createElement('main');
		om.className = 'ami-main';
		om.innerHTML = '<div class="ami-empty"><p><strong>This is your own plot.</strong></p>'
			+ '<p>Committee members can’t inspect their own plots. '
			+ 'Ask another inspector to record this one.</p></div>';
		mount.appendChild(om);
		return;
	}

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
		// Manual committee exemption / internal-review hold (distinct from the
		// automatic new-tenant exemption above). Pre-fill from an existing
		// finding so reopening shows the committee's prior decision + note.
		exemption: (existing && (existing.complianceStatus === 'exempt' || existing.complianceStatus === 'internal_review'))
			? existing.complianceStatus
			: null,
		committeeNotes: existing && existing.committeeNotes ? existing.committeeNotes : '',
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

	// New tenant: exempt from compliance notices this round (took the plot on
	// after the 1 March cutoff). Recording is still allowed — the server saves
	// it as exempt and issues no notice — so the inspector can note what they
	// see without penalising someone who's just started.
	if (plot.isNewTenant) {
		const nt = document.createElement('div');
		nt.className = 'ami-edit-banner ami-new-tenant-banner';
		nt.innerHTML = '<strong>New tenant — exempt</strong><br>'
			+ 'Taken on after the 1 March cut-off, so this plot is exempt from notices this round. '
			+ 'You can still record what you see — it’s saved as exempt and no notice is sent.';
		main.appendChild(nt);
	}

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
	// The member reads this summary in their portal, so prompt for a factual
	// description rather than a private memo (the committee-only note is below).
	notes.placeholder = 'Describe the plot’s condition…';
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
		// not edit) — the save bar renders a note instead of a button. A rating
		// OR a committee exemption is enough to save.
		if (saveBtn) saveBtn.disabled = !state.rating && !state.exemption;
	}

	rating.addEventListener('click', (e) => {
		const btn = e.target.closest('.ami-rating__btn');
		if (!btn) return;
		state.rating = parseInt(btn.dataset.rating, 10);
		state.exemption = null; // rating and exemption are alternatives
		refreshExemptionUI();
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

	// --- Committee: manual exemption / internal review ---
	// Exempt the plot (e.g. illness, away for the season) or park it for
	// Internal review (an excuse was given but the plot looks bad — the
	// committee decides), with a committee-only note. Choosing one makes the
	// Rating optional and is recorded instead of a graded verdict.
	const exemptLabel = document.createElement('label');
	exemptLabel.className = 'ami-label';
	exemptLabel.textContent = s.committeeAction || 'Committee';
	main.appendChild(exemptLabel);

	const exemptRow = document.createElement('div');
	exemptRow.className = 'ami-rating ami-rating--committee';
	exemptRow.innerHTML = `
		<button type="button" class="ami-rating__btn" data-exemption="exempt">
			<span>${escapeHtml(s.exempt || 'Exempt')}</span>
		</button>
		<button type="button" class="ami-rating__btn" data-exemption="internal_review">
			<span>${escapeHtml(s.internalReview || 'Internal review')}</span>
		</button>
	`;
	main.appendChild(exemptRow);

	// Committee-only note — revealed when an exemption / review is chosen.
	const committeeNoteWrap = document.createElement('div');
	committeeNoteWrap.className = 'ami-issue-detail';
	committeeNoteWrap.style.display = state.exemption ? '' : 'none';
	const committeeNoteLabel = document.createElement('label');
	committeeNoteLabel.className = 'ami-label';
	committeeNoteLabel.htmlFor = 'ami-committee-note';
	committeeNoteLabel.textContent = s.committeeNote || 'Committee note (not shown to the member)';
	const committeeNote = document.createElement('textarea');
	committeeNote.className = 'ami-textarea';
	committeeNote.id = 'ami-committee-note';
	committeeNote.placeholder = s.committeeNotePlaceholder || 'e.g. illness, away for the season, or “plot derelict — discuss”';
	committeeNote.value = state.committeeNotes;
	committeeNote.addEventListener('input', () => { state.committeeNotes = committeeNote.value; });
	committeeNoteWrap.appendChild(committeeNoteLabel);
	committeeNoteWrap.appendChild(committeeNote);
	main.appendChild(committeeNoteWrap);

	function refreshExemptionUI() {
		[...exemptRow.children].forEach((btn) => {
			btn.classList.toggle('ami-rating__btn--selected', btn.dataset.exemption === state.exemption);
		});
		committeeNoteWrap.style.display = state.exemption ? '' : 'none';
		refreshRatingUI(); // re-evaluate the save button (rating OR exemption)
	}

	exemptRow.addEventListener('click', (e) => {
		const btn = e.target.closest('.ami-rating__btn');
		if (!btn) return;
		const val = btn.dataset.exemption;
		// Toggle: clicking the active choice clears it. Picking an exemption
		// clears the rating — they're alternatives.
		state.exemption = (state.exemption === val) ? null : val;
		if (state.exemption) state.rating = null;
		refreshExemptionUI();
	});

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

	refreshExemptionUI(); // sets exemption pills + note visibility, and calls refreshRatingUI

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
					exemption: state.exemption,
					committeeNotes: state.committeeNotes,
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
					exemption: state.exemption,
					committeeNotes: state.committeeNotes,
				});
				findingId = (result && (result.finding_id || result.id)) || findingId;
			} else {
				// Queue a NEW finding locally (offline). issues is included so a
				// later sync sends it on to api.saveFinding verbatim. Photos get
				// tagged with the pending row's id for re-assignment after sync.
				const pending = await store.queueFinding({
					roundId, plotId, memberId: plot.memberId, rating: state.rating, notes: state.notes,
					issues: state.issues,
					exemption: state.exemption, committeeNotes: state.committeeNotes,
				});
				for (const ph of state.newPhotos) {
					await store.queuePhoto({ pendingFindingId: pending.id, blob: ph.blob, filename: ph.filename });
				}
				state.newPhotos = [];
				sync.syncOnce();
				navigate('/round/' + roundId);
				return;
			}

			// Queue the photos against the real finding id and let the background
			// sync loop upload them — do NOT await uploads here. A slow photo
			// upload over mobile data used to pin the inspector on this screen
			// until every photo finished; now the save returns immediately and
			// the header pill shows upload progress (honouring the Wi-Fi-only
			// setting). Same queue path online + offline. Each queue write is
			// guarded so a (rare) IndexedDB failure can't bubble to the outer
			// catch and wrongly re-queue the finding that already saved.
			for (const ph of state.newPhotos) {
				try {
					await store.queuePhoto({ findingId, blob: ph.blob, filename: ph.filename });
				} catch (e) {
					console.warn('Could not queue photo for upload', e);
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
			// A permanent server rejection (HTTP 400 — your own plot, a duplicate,
			// or a vacant plot) will NEVER sync, so don't queue it: that's exactly
			// how dead findings used to pile up invisibly in the queue. Show why and
			// let the inspector act (fix it, or ask another inspector to record it).
			if (e && e.code === 400) {
				saveBtn.disabled = false;
				saveBtn.textContent = s.save;
				window.alert('Couldn’t save: ' + ((e && e.message) ? e.message : 'the server rejected this finding.'));
				return;
			}
			// New finding failed for a transient reason (offline / server error) —
			// queue and bail to the round view; the sync loop drains it later.
			console.warn('Save failed, queueing', e);
			const pending = await store.queueFinding({
				roundId, plotId, memberId: plot.memberId, rating: state.rating, notes: state.notes,
				issues: state.issues,
				exemption: state.exemption, committeeNotes: state.committeeNotes,
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
