<?php
/**
 * Capability registration.
 *
 * @package AllotmentManagerInspections
 */

namespace AllotmentManagerInspections;

defined( 'ABSPATH' ) || exit;

/**
 * Grants and removes the `am_field_inspector` capability.
 */
final class Capabilities {

	/**
	 * Roles that should receive the inspector capability by default.
	 *
	 * Adjust the list and bump AMI_CAPS_VERSION to trigger a re-sync on next page load.
	 *
	 * @return string[]
	 */
	private static function default_roles(): array {
		return [
			'administrator',
			'am_site_chair',
			'am_site_secretary',
			'am_site_manager',
			'am_committee',
			'am_it_admin',
		];
	}

	/**
	 * Fired on plugin activation. Grants the capability to the default roles
	 * and stores the current version. Also flushes rewrite rules so the
	 * `/inspect/` endpoint resolves immediately.
	 *
	 * @return void
	 */
	public static function on_activate(): void {
		self::sync_caps();
		\update_option( 'ami_caps_version', AMI_CAPS_VERSION );

		// Ensure the routing endpoint is recognised after activation.
		Route::add_rewrite();
		\flush_rewrite_rules();
	}

	/**
	 * Fired on plugin deactivation. Removes the capability from the roles
	 * we granted it to. Idempotent — safe to call even if the cap was
	 * already removed.
	 *
	 * @return void
	 */
	public static function on_deactivate(): void {
		foreach ( self::default_roles() as $role_slug ) {
			$role = \get_role( $role_slug );
			if ( $role && $role->has_cap( AMI_CAPABILITY ) ) {
				$role->remove_cap( AMI_CAPABILITY );
			}
		}

		\delete_option( 'ami_caps_version' );

		// Clean up the rewrite rule.
		\flush_rewrite_rules();
	}

	/**
	 * Re-sync capabilities if the stored version differs from the constant.
	 * Hooked to `init`. Used to push updates to existing installations
	 * without requiring deactivate/reactivate.
	 *
	 * @return void
	 */
	public static function maybe_resync(): void {
		$stored = \get_option( 'ami_caps_version' );
		if ( $stored === AMI_CAPS_VERSION ) {
			return;
		}
		self::sync_caps();
		\update_option( 'ami_caps_version', AMI_CAPS_VERSION );
	}

	/**
	 * Grant the capability to each role in default_roles().
	 *
	 * @return void
	 */
	private static function sync_caps(): void {
		foreach ( self::default_roles() as $role_slug ) {
			$role = \get_role( $role_slug );
			if ( $role && ! $role->has_cap( AMI_CAPABILITY ) ) {
				$role->add_cap( AMI_CAPABILITY );
			}
		}
	}
}
