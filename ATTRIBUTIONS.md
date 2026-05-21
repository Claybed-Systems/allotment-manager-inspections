# Attributions

## browser-image-compression

Vendored at `public/js/vendor/browser-image-compression.min.js`. MIT-licensed JavaScript
library for client-side JPEG/PNG compression before upload.

Source: https://github.com/Donaldcwl/browser-image-compression

## Leaflet (loaded at runtime)

The plot map view uses the Leaflet library and the tile config from the main
`allotment-manager` plugin's `map-view.js`. We do not bundle Leaflet; it is loaded by
the main plugin when the map page is opened.

## Icons

The PWA app icons in `public/icons/` are original to this plugin. The base graphic
re-uses the sprout glyph from the Lucide icon set (ISC License) that the
allotment-theme already ships.
