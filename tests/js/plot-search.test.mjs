/**
 * The shared plot-search matcher.
 *
 * Run with `node --test "tests/js/*.test.mjs"` — Node's built-in runner, no
 * dependencies. plot-search.js is a dependency-free ES module, so it imports
 * as-is. Quote the glob: bare `node --test tests/js` does not pick these up.
 *
 * These exist because the website's admin map shipped this same search with a
 * matcher that tested the DOM rather than the data (ams#902): a plot inside a
 * collapsed marker cluster was invisible to it, and searching an ordinary plot
 * number reported "no matches" on a live round. The field app's matcher never
 * touches the DOM. That is only true while something checks it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	normaliseQuery,
	matchesQuery,
	filterPlots,
	firstMatch,
} from '../../public/js/services/plot-search.js';

/** A plot as listPlots() returns it, trimmed to what the search reads. */
function plot(plotNumber, tenantName, coords = true) {
	return {
		plotNumber,
		tenantName,
		lat: coords ? 55.9 : null,
		lng: coords ? -3.2 : null,
	};
}

// The round as the server hands it over: prefix, then number, then
// subdivision. filterPlots must not reorder it.
const ROUND = [
	plot('B2', 'Charles Babbage'),
	plot('B9', 'Ada Lovelace'),
	plot('B15', 'Ada Lovelace'),
	plot('B15.1', 'Ada Lovelace'),
	plot('B17', 'Ada Lovelace'),
	plot('B19', 'Grace Hopper'),
];

test('normaliseQuery trims and lowercases', () => {
	assert.equal(normaliseQuery('  B15 '), 'b15');
	assert.equal(normaliseQuery('Lovelace'), 'lovelace');
});

test('normaliseQuery treats absent input as no search', () => {
	assert.equal(normaliseQuery(undefined), '');
	assert.equal(normaliseQuery(null), '');
	assert.equal(normaliseQuery('   '), '');
});

test('matches a plot number regardless of the case typed', () => {
	assert.equal(matchesQuery(plot('B15', 'Ada Lovelace'), 'b15'), true);
});

test('matches a tenant name', () => {
	assert.equal(matchesQuery(plot('B15', 'Ada Lovelace'), 'lovelace'), true);
});

test('does not match an unrelated term', () => {
	assert.equal(matchesQuery(plot('B15', 'Ada Lovelace'), 'babbage'), false);
});

test('a vacant plot has no tenant name to match on, and does not throw', () => {
	assert.equal(matchesQuery(plot('B15', null), 'b15'), true);
	assert.equal(matchesQuery(plot('B15', null), 'lovelace'), false);
});

test('an empty query matches nothing on its own', () => {
	// matchesQuery answers "is this a hit"; filterPlots is what decides that no
	// search means show everything. Keeping the two apart is what lets the
	// search compose with the status chips.
	assert.equal(matchesQuery(plot('B15', 'Ada Lovelace'), ''), false);
});

test('an empty query leaves the round untouched, so it composes with the filter', () => {
	assert.equal(filterPlots(ROUND, ''), ROUND);
});

test('filtering keeps the server order, which is plot-number order', () => {
	const numbers = filterPlots(ROUND, 'lovelace').map((p) => p.plotNumber);
	assert.deepEqual(numbers, ['B9', 'B15', 'B15.1', 'B17']);
});

test('the map focuses the lowest-numbered plot a tenant holds', () => {
	assert.equal(firstMatch(ROUND, 'lovelace').plotNumber, 'B9');
});

test('a subdivided plot does not jump ahead of its own parent', () => {
	// B15.1 sorts after B15 on the server (#42). A client-side natural sort of
	// the strings would agree here, but the point is that we do not sort at
	// all — so this holds for whatever the server decides.
	assert.equal(firstMatch(ROUND, 'b15').plotNumber, 'B15');
});

test('focus skips a match that has no coordinates to fly to', () => {
	const unplaced = [plot('B9', 'Ada Lovelace', false), plot('B15', 'Ada Lovelace')];
	assert.equal(firstMatch(unplaced, 'lovelace').plotNumber, 'B15');
});

test('no query means no focus, so the map keeps its own view', () => {
	assert.equal(firstMatch(ROUND, ''), null);
});

test('a query nothing matches focuses nothing', () => {
	assert.equal(firstMatch(ROUND, 'zzz'), null);
	assert.deepEqual(filterPlots(ROUND, 'zzz'), []);
});

test('an absent plot list is not a crash', () => {
	assert.deepEqual(filterPlots(undefined, 'b15'), []);
	assert.equal(firstMatch(undefined, 'b15'), null);
});
