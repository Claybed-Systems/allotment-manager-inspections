<?php
/**
 * Plugin Name: Allotment Manager - Field Inspector
 * Plugin URI: https://github.com/juettemann/allotment-manager-inspections
 * Description: Mobile-first PWA for committee members to record plot inspections in the field. Depends on the main Allotment Manager plugin for data, AJAX handlers and Google Drive photo storage.
 * Version: 1.0.0
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
define( 'AMI_VERSION', '1.0.0' );

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
 */
define( 'AMI_CAPS_VERSION', '1' );

require_once AMI_PLUGIN_DIR . 'includes/class-plugin.php';
require_once AMI_PLUGIN_DIR . 'includes/class-capabilities.php';
require_once AMI_PLUGIN_DIR . 'includes/class-route.php';
require_once AMI_PLUGIN_DIR . 'includes/ajax/class-inspect-ajax.php';

// Activation / deactivation hooks: register/remove the capability.
\register_activation_hook( __FILE__, [ Capabilities::class, 'on_activate' ] );
\register_deactivation_hook( __FILE__, [ Capabilities::class, 'on_deactivate' ] );

// Boot.
\add_action( 'plugins_loaded', [ Plugin::class, 'instance' ] );
