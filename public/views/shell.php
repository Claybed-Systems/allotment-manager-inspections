<?php
/**
 * SPA shell — single HTML response for every /inspect/... URL.
 *
 * The full app lives in JS modules; this template just provides:
 *   - <head> with PWA manifest, theme color, viewport
 *   - critical CSS for the initial render
 *   - the mount point #app
 *   - localised data (URLs, nonces, strings)
 *   - the entry script
 *
 * @package AllotmentManagerInspections
 *
 * @var array<string,mixed> $data Provided by Route::maybe_render().
 */

defined( 'ABSPATH' ) || exit;

$css_url      = AMI_PLUGIN_URL . 'public/css/inspect.css?ver=' . AMI_VERSION;
$app_url      = AMI_PLUGIN_URL . 'public/js/app.js?ver=' . AMI_VERSION;
$manifest_url = AMI_PLUGIN_URL . 'public/manifest.webmanifest?ver=' . AMI_VERSION;
?><!doctype html>
<html <?php \language_attributes(); ?>>
<head>
	<meta charset="<?php \bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
	<meta name="theme-color" content="#6b8e6f">
	<meta name="apple-mobile-web-app-capable" content="yes">
	<meta name="apple-mobile-web-app-status-bar-style" content="default">
	<meta name="apple-mobile-web-app-title" content="Inspector">
	<link rel="manifest" href="<?php echo \esc_url( $manifest_url ); ?>">
	<link rel="icon" href="<?php echo \esc_url( AMI_PLUGIN_URL . 'public/icons/icon-192.png' ); ?>" type="image/png">
	<link rel="apple-touch-icon" href="<?php echo \esc_url( AMI_PLUGIN_URL . 'public/icons/icon-192.png' ); ?>">
	<title><?php \esc_html_e( 'Field Inspector', 'allotment-manager-inspections' ); ?></title>
	<link rel="stylesheet" href="<?php echo \esc_url( $css_url ); ?>">
	<style>
		/* Critical, render-before-CSS-loads styles to avoid white flash. */
		html, body { margin: 0; padding: 0; background: #fdfcfb; color: #3d3428; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		#app { min-height: 100vh; display: flex; flex-direction: column; }
		.ami-boot { display: flex; align-items: center; justify-content: center; flex: 1; color: #5c5347; font-size: 14px; }
	</style>
</head>
<body class="ami-app">
	<div id="app">
		<div class="ami-boot"><?php \esc_html_e( 'Loading the field inspector…', 'allotment-manager-inspections' ); ?></div>
	</div>

	<script>
		window.amiData = <?php echo \wp_json_encode( $data ); ?>;
	</script>
	<script type="module" src="<?php echo \esc_url( $app_url ); ?>"></script>
</body>
</html>
<?php
