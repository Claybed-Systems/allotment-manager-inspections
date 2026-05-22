<?php
/**
 * PHPUnit bootstrap for allotment-manager-inspections.
 *
 * Mirrors the events plugin's bootstrap pattern. Loads:
 *   1. WordPress test functions
 *   2. The main `allotment-manager` plugin (provides AllotmentManager\Plugin
 *      class that our base-plugin-active guard checks for)
 *   3. The inspections plugin under test
 *
 * @package AllotmentManagerInspections
 */

$_tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $_tests_dir ) {
	$_tests_dir = rtrim( sys_get_temp_dir(), '/\\' ) . '/wordpress-tests-lib';
}

if ( ! file_exists( $_tests_dir . '/includes/functions.php' ) ) {
	echo "Could not find {$_tests_dir}/includes/functions.php\n";
	exit( 1 );
}

require_once $_tests_dir . '/includes/functions.php';

/**
 * Manually load both plugins.
 *
 * @return void
 */
function _ami_manually_load_plugins(): void {
	// Base plugin first — defines AllotmentManager\Plugin, AM_VERSION,
	// and the namespace our handlers reach into.
	require dirname( __DIR__, 2 ) . '/allotment-manager/allotment-manager.php';

	// Then the inspections plugin under test.
	require dirname( __DIR__ ) . '/allotment-manager-inspections.php';
}

tests_add_filter( 'muplugins_loaded', '_ami_manually_load_plugins' );

require $_tests_dir . '/includes/bootstrap.php';
