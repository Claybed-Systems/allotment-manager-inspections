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

	const state = {
		rating: existing ? categoryToRating(existing.complianceCategory) : null,
		notes: existing ? (existing.findingsSummary || '') : '',
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
			cell.innerHTML = `<img src="${p.url}" alt=""><span class="ami-photo__queue-tag">new</span>`;
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
		saveBtn.disabled = !state.rating;
	}

	rating.addEventListener('click', (e) => {
		const btn = e.target.closest('.ami-rating__btn');
		if (!btn) return;
		state.rating = parseInt(btn.dataset.rating, 10);
		refreshRatingUI();
	});

	// --- Sticky save bar ---
	const saveBar = document.createElement('div');
	saveBar.className = 'ami-save-bar';
	saveBar.innerHTML = `<button type="button" class="ami-btn" id="ami-save">${s.save}</button>`;
	mount.appendChild(saveBar);
	const saveBtn = saveBar.querySelector('#ami-save');

	refreshRatingUI();

	saveBtn.addEventListener('click', async () => {
		saveBtn.disabled = true;
		saveBtn.textContent = '…';

		let findingId = existing ? existing.id : null;

		try {
			// Save (or update) the finding.
			if (navigator.onLine) {
				const result = await api.saveFinding({
					roundId,
					plotId,
					memberId: plot.memberId,
					rating: state.rating,
					notes: state.notes,
				});
				findingId = (result && (result.finding_id || result.id)) || findingId;
			} else {
				// Queue locally.
				const pending = await store.queueFinding({
					roundId, plotId, memberId: plot.memberId, rating: state.rating, notes: state.notes,
				});
				// Photos taken offline get tagged with the pending row's id so
				// they can be re-assigned to the real findingId after sync.
				for (const ph of state.newPhotos) {
					await store.queuePhoto({ pendingFindingId: pending.id, blob: ph.blob, filename: ph.filename });
				}
				state.newPhotos = [];
				sync.syncOnce();
				navigate('/round/' + roundId);
				return;
			}

			// Upload photos now we have a real finding id.
			for (const ph of state.newPhotos) {
				try {
					await api.uploadPhoto({ findingId, blob: ph.blob, filename: ph.filename });
				} catch (e) {
					// Queue for retry.
					await store.queuePhoto({ findingId, blob: ph.blob, filename: ph.filename });
				}
			}
			state.newPhotos = [];

			sync.syncOnce();
			navigate('/round/' + roundId);
		} catch (e) {
			// Couldn't save online — queue and bail to the round view.
			console.warn('Save failed, queueing', e);
			const pending = await store.queueFinding({
				roundId, plotId, memberId: plot.memberId, rating: state.rating, notes: state.notes,
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
