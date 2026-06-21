<?php
/**
 * Plugin Name: Allotment Manager - Field Inspector
 * Plugin URI: https://github.com/juettemann/allotment-manager-inspections
 * Description: Mobile-first PWA for committee members to record plot inspections in the field. Depends on the main Allotment Manager plugin for data, AJAX handlers and Google Drive photo storage.
 * Version: 1.2.4
 * Author: Thomas Juettemann
 * Author URI: https://juettemann.co.uk
 * License: GPL v2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: allotment-manager-inspections
 * Domain Path: /languages
 * Requires at least: 6.7
 * Requires PHP: 8.1
 *
 * @package AllotmentManagerInspections
 */

namespace AllotmentManagerInspections;

defined( 'ABSPATH' ) || exit;

/**
 * Plugin version.
 */
define( 'AMI_VERSION', '1.2.4' );

/**
 * Plugin directory path.
 */
define( 'AMI_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

/**
 * Plugin URL.
 */
define( 'AMI_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

/**
 * Plugin file.
 */
define( 'AMI_PLUGIN_FILE', __FILE__ );

/**
 * Inspector capability slug.
 */
define( 'AMI_CAPABILITY', 'am_field_inspector' );

/**
 * Capability set version. Bump when the set of granted caps changes; the
 * activation re-sync runs whenever the stored version differs.
 *
 * v2: re-grant am_field_inspector to the committee roles (am_site_chair,
 * am_site_secretary, am_site_manager, am_committee, am_it_admin). On the
 * existing installs these roles were created by the main plugin AFTER the
 * inspector was first activated, so the original v1 sync — which skips
 * roles that don't exist yet — only ever reached `administrator`.
 */
define( 'AMI_CAPS_VERSION', '2' );

require_once AMI_PLUGIN_DIR . 'includes/class-plugin.php';
require_once AMI_PLUGIN_DIR . 'includes/class-capabilities.php';
require_once AMI_PLUGIN_DIR . 'includes/class-route.php';
require_once AMI_PLUGIN_DIR . 'includes/ajax/class-inspect-ajax.php';

/**
 * Minimum required base-plugin version.
 */
define( 'AMI_REQUIRED_AM_VERSION', '2.4.0' );

/**
 * Check whether the main Allotment Manager plugin is active and at the
 * required minimum version. Without it, the inspector plugin's AJAX
 * endpoints and routes can't function — they call into the main plugin's
 * services + capabilities. Audit finding D (May 21 2026 audit).
 *
 * @return bool
 */
function is_base_plugin_active(): bool {
	// Main plugin's Plugin class is only defined when the plugin is
	// active and its autoloader is registered. Lightweight check —
	// avoids loading wp-admin/includes/plugin.php for is_plugin_active().
	if ( ! class_exists( 'AllotmentManager\\Plugin' ) ) {
		return false;
	}

	if ( defined( 'AM_VERSION' ) ) {
		return version_compare( AM_VERSION, AMI_REQUIRED_AM_VERSION, '>=' );
	}

	// AM_VERSION not yet defined (very early in plugins_loaded ordering)
	// — assume compatible. Late requests will re-check.
	return true;
}

/**
 * Show an admin notice when the base plugin is missing.
 */
function base_plugin_required_notice(): void {
	if ( ! current_user_can( 'activate_plugins' ) ) {
		return;
	}
	echo '<div class="notice notice-error"><p>';
	printf(
		/* translators: %s: minimum AM version */
		esc_html__( 'Allotment Manager - Field Inspector requires the Allotment Manager plugin (version %s or higher) to be installed and activated.', 'allotment-manager-inspections' ),
		esc_html( AMI_REQUIRED_AM_VERSION )
	);
	echo '</p></div>';
}

/**
 * Boot the plugin if its base plugin is active. Wraps Plugin::instance so
 * we can gate execution behind the base-plugin check — register_*_hook
 * callbacks fire from the standalone bootstrap and don't need the gate.
 */
function init_plugin(): void {
	if ( ! is_base_plugin_active() ) {
		add_action( 'admin_notices', __NAMESPACE__ . '\\base_plugin_required_notice' );
		return;
	}
	Plugin::instance();
}

// Activation / deactivation hooks: register/remove the capability.
\register_activation_hook( __FILE__, [ Capabilities::class, 'on_activate' ] );
\register_deactivation_hook( __FILE__, [ Capabilities::class, 'on_deactivate' ] );

// Boot. Run at priority 20 so the base plugin's plugins_loaded hook
// (default priority 10) has already fired and registered its Plugin class.
\add_action( 'plugins_loaded', __NAMESPACE__ . '\\init_plugin', 20 );
