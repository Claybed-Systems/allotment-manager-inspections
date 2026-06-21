# Attributions

## browser-image-compression

Vendored at `public/js/vendor/browser-image-compression.min.js`. MIT-licensed JavaScript
library for client-side JPEG/PNG compression before upload.

Source: https://github.com/Donaldcwl/browser-image-compression

## Leaflet (bundled)

Vendored at `public/vendor/leaflet/` (`leaflet.js`, `leaflet.css`, `images/`). Leaflet
1.9.4, BSD-2-Clause licensed. The plot map view (`public/js/pages/plot-map.js`) loads it
on demand and the service worker precaches it, so the map works offline — fitting for a
field app. Tile config is resolved server-side via the shared `am_map_tile_layer` filter.

Source: https://leafletjs.com / https://github.com/Leaflet/Leaflet

## Icons

The PWA app icons in `public/icons/` are original to this plugin. The base graphic
re-uses the sprout glyph from the Lucide icon set (ISC License) that the
allotment-theme already ships.
