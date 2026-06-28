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
 * Resolve a plugin main-file path from an env var, falling back to a default.
 *
 * @param string $env_var  Environment variable holding an explicit path.
 * @param string $fallback Default path to try when the env var is unset/missing.
 * @return string|null The first path that exists, or null.
 */
function _ami_locate_plugin( string $env_var, string $fallback ): ?string {
	$explicit = getenv( $env_var );
	if ( $explicit && file_exists( $explicit ) ) {
		return $explicit;
	}
	return file_exists( $fallback ) ? $fallback : null;
}

/**
 * Manually load the plugins the suite needs.
 *
 * The base allotment-manager plugin (and its MemberManager dependency) live in
 * a SEPARATE repository, so their location varies by checkout layout. Each is
 * resolved from an env var first, then a sensible default:
 *   - AM_PLUGIN_FILE / sibling default (~/repos/allotment-manager next to this
 *     repo). CI sets AM_PLUGIN_FILE to the path inside its allotment-manager
 *     checkout.
 *   - MM_PLUGIN_FILE / beside allotment-manager. Loaded when found so the base
 *     plugin boots fully (matching the live runtime); guarded, so a layout
 *     without MemberManager is unaffected.
 *
 * @return void
 */
function _ami_manually_load_plugins(): void {
	$repos = dirname( __DIR__, 2 );

	$am = _ami_locate_plugin( 'AM_PLUGIN_FILE', $repos . '/allotment-manager/allotment-manager.php' );
	if ( null === $am ) {
		echo "Could not locate the allotment-manager plugin. Set AM_PLUGIN_FILE to its allotment-manager.php.\n";
		exit( 1 );
	}

	// MemberManager is allotment-manager's dependency — load it first when found.
	$mm = _ami_locate_plugin( 'MM_PLUGIN_FILE', dirname( $am, 2 ) . '/member-manager/member-manager.php' );
	if ( null !== $mm ) {
		require $mm;
	}

	require $am;

	// Then the inspections plugin under test.
	require dirname( __DIR__ ) . '/allotment-manager-inspections.php';
}

tests_add_filter( 'muplugins_loaded', '_ami_manually_load_plugins' );

require $_tests_dir . '/includes/bootstrap.php';
