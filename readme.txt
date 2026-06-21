=== Allotment Manager - Field Inspector ===

Contributors: juettemann
Tags: allotment, inspection, pwa, mobile
Requires at least: 6.7
Tested up to: 6.7
Requires PHP: 8.1
Stable tag: 1.1.6
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

A mobile-first Progressive Web App for committee members to record plot inspections in the field.

== Description ==

Field Inspector is an add-on to the main Allotment Manager plugin. It exposes a phone- and tablet-friendly inspection tool at `/inspect/` that committee members use while walking the site to record plot ratings, notes and photos.

Features:

* Mobile-first UI with large tap targets
* Three-rating system: Pass / Minor / Major
* Camera-driven photo capture (uses native `<input capture>`)
* Works offline (Service Worker + IndexedDB queue) with automatic sync when back online
* Map view of the plots (Leaflet, reuses main-plugin tile config)
* Round-aware: first round shows every plot in the section; follow-up round shows only plots rated 2 or 3 in the parent round
* Capability-gated: only users with `am_field_inspector` can access
* Add to Home Screen as a PWA

== Dependencies ==

This plugin assumes the main `allotment-manager` plugin is installed and active (v2.2.0 or later). It reuses:

* `Inspection_Service::record_plot_inspection()` for saving findings
* `am_inspection_upload_photo` AJAX endpoint for photo uploads to Google Drive
* `Plot_Repository::get_by_section()` for plot listings
* `wp_am_map_objects` for plot polygons

== Installation ==

1. Activate the Allotment Manager plugin (parent dependency).
2. Activate this plugin. On activation, the `am_field_inspector` capability is granted to committee roles.
3. Visit `/inspect/` while logged in as a committee member.

== Changelog ==

= 1.1.6 =
* Map: plot labels are now rotated to run along each plot (matching the admin Map Editor), instead of horizontal labels that overlapped each other.

= 1.1.5 =
* Map: plot number and tenant name are now always shown as labels on each plot, instead of only on hover.

= 1.1.4 =
* Map: draw each plot as its real footprint — a rotated rectangle that scales with the satellite imagery as you zoom — instead of a fixed-size dot, using the width/height/rotation from the admin Map Editor. Coloured by inspection status.

= 1.1.3 =
* Map: fix "Map data not yet available" when zooming in. The map now honours the tile provider's max native zoom (Esri imagery stops at zoom 19), so zooming in upscales the deepest real imagery instead of requesting tiles that don't exist.

= 1.1.2 =
* Internal: share the status-badge mapping between the plot list and map (new js/components/badge.js) so they can't drift; cancel the map's deferred resize timer on teardown. No user-facing change.

= 1.1.1 =
* Grant the inspector capability to the committee roles (chair, secretary, manager, committee, IT admin), not just administrators. On existing installs these roles were created after the inspector was first activated, so the original sync only reached administrators — bumping the caps version re-runs it.

= 1.1.0 =
* Plot Map view: the round's plots are drawn on a Leaflet map, coloured by inspection status (not inspected / Pass / Cat 2 / Cat 3). Tap a plot to inspect it.
* Leaflet is now bundled locally and precached by the service worker, so the map works offline.

= 1.0.0 =
* Initial release.
