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
	 * Capability that lets the holder edit ANY inspection finding (not only
	 * their own). Granted to the chair; admins are covered by manage_options.
	 */
	public const EDIT_ANY_CAP = 'edit_any_inspection_finding';

	/**
	 * Roles that receive the "edit any finding" override. The chair only —
	 * administrator is covered by manage_options at the check site, so it is
	 * deliberately not listed here.
	 *
	 * @return string[]
	 */
	private static function override_roles(): array {
		return [ 'am_site_chair' ];
	}

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
			// am_it_admin is deliberately excluded (v4): IT Admin is a
			// system-configuration role, not an inspector. It also lacks
			// record_inspection_findings (granted in allotment-manager), so
			// granting PWA access alone 403'd every save/edit. Don't re-add
			// without also granting record_inspection_findings there.
		];
	}

	/**
	 * The default roles minus `administrator`. Administrator is a WordPress core
	 * role that MemberManager grants caps to separately (not via
	 * create_or_update_role), and a role rebuild never strips its caps — so it
	 * keeps the cap from sync_caps() and does NOT need the filter injection.
	 *
	 * @return string[]
	 */
	private static function filter_roles(): array {
		return \array_values( \array_diff( self::default_roles(), [ 'administrator' ] ) );
	}

	/**
	 * Inject `am_field_inspector` into the committee roles whenever MemberManager
	 * (re)builds them, via its `am_role_capabilities` seam.
	 *
	 * MM's `Roles::create_or_update_role()` REMOVES every cap not in the filtered
	 * set before re-adding, so a cap that was only `add_cap()`'d on afterwards
	 * (as on_activate()/maybe_resync() do) is wiped on the next ROLES_VERSION
	 * bump. Hooking the filter makes the cap part of the role definition, so it
	 * survives every rebuild. The filter passes a `['cap' => bool]` map.
	 *
	 * @param mixed  $caps      Capability map being built for the role.
	 * @param string $role_slug Role being created/updated.
	 * @return array<string,bool>
	 */
	public static function inject_inspector_cap( $caps, string $role_slug ): array {
		$caps = (array) $caps;
		if ( \in_array( $role_slug, self::filter_roles(), true ) ) {
			$caps[ AMI_CAPABILITY ] = true;
		}
		if ( \in_array( $role_slug, self::override_roles(), true ) ) {
			$caps[ self::EDIT_ANY_CAP ] = true;
		}
		return $caps;
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
		foreach ( self::override_roles() as $role_slug ) {
			$role = \get_role( $role_slug );
			if ( $role && $role->has_cap( self::EDIT_ANY_CAP ) ) {
				$role->remove_cap( self::EDIT_ANY_CAP );
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
		foreach ( self::override_roles() as $role_slug ) {
			$role = \get_role( $role_slug );
			if ( $role && ! $role->has_cap( self::EDIT_ANY_CAP ) ) {
				$role->add_cap( self::EDIT_ANY_CAP );
			}
		}
	}
}
