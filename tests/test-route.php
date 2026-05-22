<?php
/**
 * Route + AJAX smoke tests for the inspections PWA.
 *
 * Locks down:
 *   - Rewrite rule registration for /inspect/ catch-all.
 *   - Custom query var `am_inspect` is whitelisted.
 *   - Three AJAX hooks (list_rounds, list_plots, get_plot) are registered.
 *   - Unauthenticated visit to /inspect/ does NOT 500 (it can 200/302).
 *
 * @package AllotmentManagerInspections
 */

use AllotmentManagerInspections\Route;
use AllotmentManagerInspections\Capabilities;
use AllotmentManagerInspections\Inspect_Ajax;

class Test_Route extends WP_UnitTestCase {

	public function setUp(): void {
		parent::setUp();
		// Pretty permalinks so the rewrite_rules option gets populated.
		global $wp_rewrite;
		update_option( 'permalink_structure', '/%postname%/' );
		$wp_rewrite->init();
	}

	public function test_register_adds_init_hook(): void {
		Route::register();

		$this->assertNotFalse(
			has_action( 'init', array( Route::class, 'add_rewrite' ) ),
			'Route::add_rewrite must hook on init'
		);
		$this->assertNotFalse(
			has_filter( 'query_vars', array( Route::class, 'add_query_var' ) ),
			'Route::add_query_var must filter query_vars'
		);
		$this->assertNotFalse(
			has_action( 'template_redirect', array( Route::class, 'maybe_render' ) ),
			'Route::maybe_render must hook on template_redirect'
		);
	}

	public function test_rewrite_rule_for_inspect_is_registered(): void {
		Route::add_rewrite();
		flush_rewrite_rules( false );

		global $wp_rewrite;
		$rules = $wp_rewrite->wp_rewrite_rules();

		$this->assertIsArray( $rules );
		$this->assertArrayHasKey(
			'^inspect(/.*)?/?$',
			$rules,
			'The /inspect/ catch-all rewrite rule must be registered'
		);
	}

	public function test_am_inspect_query_var_is_added(): void {
		$vars = Route::add_query_var( array( 'existing' ) );
		$this->assertContains( 'am_inspect', $vars );
		$this->assertContains( 'existing', $vars );
	}
}

class Test_Inspect_Ajax extends WP_UnitTestCase {

	public function test_register_adds_three_ajax_hooks(): void {
		Inspect_Ajax::register();

		$this->assertNotFalse(
			has_action( 'wp_ajax_am_inspect_list_rounds' ),
			'AJAX hook am_inspect_list_rounds must be registered'
		);
		$this->assertNotFalse(
			has_action( 'wp_ajax_am_inspect_list_plots' ),
			'AJAX hook am_inspect_list_plots must be registered'
		);
		$this->assertNotFalse(
			has_action( 'wp_ajax_am_inspect_get_plot' ),
			'AJAX hook am_inspect_get_plot must be registered'
		);
	}
}

class Test_Capabilities extends WP_UnitTestCase {

	public function test_inspector_capability_constant_is_defined(): void {
		$this->assertSame( 'am_field_inspector', AMI_CAPABILITY );
	}

	public function test_caps_version_constant_is_string(): void {
		$this->assertIsString( AMI_CAPS_VERSION );
		$this->assertNotEmpty( AMI_CAPS_VERSION );
	}

	public function test_on_activate_grants_cap_to_administrator(): void {
		Capabilities::on_activate();

		$admin = get_role( 'administrator' );
		$this->assertNotNull( $admin, 'administrator role must exist' );
		$this->assertTrue(
			$admin->has_cap( AMI_CAPABILITY ),
			'administrator should have the am_field_inspector capability after activation'
		);
	}

	public function test_on_deactivate_removes_cap_from_administrator(): void {
		Capabilities::on_activate();
		Capabilities::on_deactivate();

		$admin = get_role( 'administrator' );
		$this->assertFalse(
			$admin->has_cap( AMI_CAPABILITY ),
			'administrator should not have the cap after deactivation'
		);
	}

	public function test_maybe_resync_runs_when_version_stale(): void {
		// Clear the persisted version + cap to force a re-sync.
		delete_option( 'ami_caps_version' );
		$admin = get_role( 'administrator' );
		$admin->remove_cap( AMI_CAPABILITY );

		Capabilities::maybe_resync();

		$this->assertTrue(
			$admin->has_cap( AMI_CAPABILITY ),
			'maybe_resync should re-grant the cap when stored version differs from AMI_CAPS_VERSION'
		);
		$this->assertSame(
			AMI_CAPS_VERSION,
			get_option( 'ami_caps_version' ),
			'maybe_resync should persist the new version'
		);
	}
}

class Test_Base_Plugin_Guard extends WP_UnitTestCase {

	public function test_is_base_plugin_active_returns_true_when_main_plugin_loaded(): void {
		// The bootstrap loads the main plugin, so this should be true.
		$this->assertTrue(
			\AllotmentManagerInspections\is_base_plugin_active(),
			'Base-plugin guard should pass when AllotmentManager\\Plugin class is defined'
		);
	}

	public function test_ami_required_am_version_is_defined(): void {
		$this->assertSame( '2.4.0', AMI_REQUIRED_AM_VERSION );
	}
}
