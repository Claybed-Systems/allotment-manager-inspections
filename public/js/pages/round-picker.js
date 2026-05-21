/**
 * Round picker — the landing page at /inspect/#/
 *
 * Lists active (scheduled / in_progress) inspection rounds. Each row is
 * tappable and navigates to /inspect/#/round/<id>.
 */

import * as api from '../services/api.js';
import { renderHeader } from '../components/header.js';

const s = window.amiData.strings;

export async function render(_params, { mount, navigate }) {
	mount.innerHTML = '';
	mount.appendChild(renderHeader({
		title: 'Field Inspector',
		subtitle: window.amiData.currentUser.displayName || '',
		showBack: false,
	}));

	const main = document.createElement('main');
	main.className = 'ami-main';
	main.innerHTML = `<div class="ami-spinner" aria-label="${s.loading}"></div>`;
	mount.appendChild(main);

	let rounds;
	try {
		const data = await api.listRounds();
		rounds = data.rounds || [];
	} catch (e) {
		main.innerHTML = `<div class="ami-error">${escapeHtml(e.message)}</div>`;
		return;
	}

	main.innerHTML = '';

	if (!rounds.length) {
		const empty = document.createElement('div');
		empty.className = 'ami-empty';
		empty.textContent = s.noRounds;
		main.appendChild(empty);
		return;
	}

	const title = document.createElement('h2');
	title.className = 'ami-section-title';
	title.textContent = 'Active rounds';
	main.appendChild(title);

	for (const r of rounds) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'ami-card';
		card.onclick = () => navigate('/round/' + r.id);

		const pct = r.totalPlots > 0 ? Math.min(100, Math.round((r.inspectedPlots / r.totalPlots) * 100)) : 0;
		const typeLabel = r.inspectionType === 'followup' ? 'Follow-up' : 'First round';
		const typeClass = r.inspectionType === 'followup' ? 'ami-round-type--followup' : 'ami-round-type--primary';

		card.innerHTML = `
			<div class="ami-card__top">
				<span class="ami-card__title">${escapeHtml(r.roundNumber)}</span>
				<span class="ami-round-type ${typeClass}">${typeLabel}</span>
			</div>
			<div class="ami-card__meta">${escapeHtml(r.siteSection)} · ${escapeHtml(formatDate(r.scheduledStartDate))}</div>
			<div class="ami-card__detail">${formatProgress(r.inspectedPlots, r.totalPlots)}</div>
			<div class="ami-progress-bar"><div class="ami-progress-bar__fill" style="width:${pct}%"></div></div>
		`;
		main.appendChild(card);
	}
}

function formatDate(d) {
	if (!d) return '—';
	try {
		const date = new Date(d + 'T00:00:00');
		return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
	} catch { return d; }
}

function formatProgress(done, total) {
	if (!total) return `${done} inspected`;
	return s.progress.replace('%d', done).replace('%d', total);
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = String(str ?? '');
	return div.innerHTML;
}
