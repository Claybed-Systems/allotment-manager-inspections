<?php
/**
 * Plugin singleton bootstrap.
 *
 * @package AllotmentManagerInspections
 */

namespace AllotmentManagerInspections;

defined( 'ABSPATH' ) || exit;

/**
 * Plugin class. Wires up routing, AJAX and asset enqueue.
 */
final class Plugin {

	/**
	 * Singleton instance.
	 *
	 * @var Plugin|null
	 */
	private static ?Plugin $instance = null;

	/**
	 * Get the singleton.
	 *
	 * @return Plugin
	 */
	public static function instance(): Plugin {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Constructor — registers hooks.
	 */
	private function __construct() {
		Route::register();
		Inspect_Ajax::register();

		// Inject the inspector cap into the committee roles via MemberManager's
		// `am_role_capabilities` seam, so a MemberManager ROLES_VERSION rebuild
		// (which strips every cap not in the filtered set) can't wipe it. This
		// is the durable grant; the add_cap in maybe_resync() below is only a
		// belt for installs where MM isn't the role authority.
		\add_filter( 'am_role_capabilities', [ Capabilities::class, 'inject_inspector_cap' ], 10, 2 );

		// Re-sync capability on init if version bumped (matches main plugin's
		// versioned role-sync pattern). Activation runs the cap grant on
		// first install; this catches version bumps on subsequent updates.
		\add_action( 'init', [ Capabilities::class, 'maybe_resync' ] );

		// Filter to expose this plugin's version for diagnostic logging.
		\add_filter( 'am_field_inspector_version', static fn() => AMI_VERSION );
	}

	/**
	 * Convenience accessor for the plugin's localised JS data array,
	 * built fresh each time it is needed (so nonces stay valid).
	 *
	 * @return array<string,mixed>
	 */
	public static function script_data(): array {
		$user = \wp_get_current_user();
		return [
			'ajaxUrl'      => \admin_url( 'admin-ajax.php' ),
			'baseUrl'      => \home_url( '/inspect/' ),
			'pluginUrl'    => AMI_PLUGIN_URL,
			'version'      => AMI_VERSION,
			'nonces'       => [
				// 'inspect' covers the read endpoints AND am_inspect_save_finding.
				'inspect'      => \wp_create_nonce( 'am_inspect_nonce' ),
				'uploadPhoto'  => \wp_create_nonce( 'am_inspection_upload_photo' ),
			],
			'currentUser'  => [
				'id'           => $user ? (int) $user->ID : 0,
				'displayName'  => $user ? $user->display_name : '',
			],
			'capabilities' => [
				'inspector' => \current_user_can( AMI_CAPABILITY ),
			],
			'strings'      => [
				'online'        => \__( 'Online', 'allotment-manager-inspections' ),
				'offline'       => \__( 'Offline', 'allotment-manager-inspections' ),
				'queued'        => \__( '%d queued', 'allotment-manager-inspections' ),
				'pass'          => \__( 'Pass', 'allotment-manager-inspections' ),
				'minor'         => \__( 'Minor corrections', 'allotment-manager-inspections' ),
				'major'         => \__( 'Major corrections', 'allotment-manager-inspections' ),
				'takePhoto'     => \__( 'Take photo', 'allotment-manager-inspections' ),
				'save'          => \__( 'Save', 'allotment-manager-inspections' ),
				'back'          => \__( 'Back', 'allotment-manager-inspections' ),
				'noRounds'      => \__( 'No active inspection rounds. Ask the committee to schedule one.', 'allotment-manager-inspections' ),
				'loading'       => \__( 'Loading…', 'allotment-manager-inspections' ),
				'saveError'     => \__( 'Could not save. Queued for later.', 'allotment-manager-inspections' ),
				'photoError'    => \__( 'Could not upload photo. Queued for later.', 'allotment-manager-inspections' ),
				'notInspected'  => \__( 'Not inspected', 'allotment-manager-inspections' ),
				'cat1'          => \__( 'Pass', 'allotment-manager-inspections' ),
				'cat2'          => \__( 'Cat 2', 'allotment-manager-inspections' ),
				'cat3'          => \__( 'Cat 3', 'allotment-manager-inspections' ),
				// Verdict labels for a finding with no cultivation category — the
				// axis the committee's own round screen badges and filters by.
				// Wording matches that screen so the two read the same.
				'statusNonCompliant' => \__( 'Non-compliant', 'allotment-manager-inspections' ),
				'statusExempt'       => \__( 'Exempt', 'allotment-manager-inspections' ),
				'statusNewTenant'    => \__( 'New tenant', 'allotment-manager-inspections' ),
				'statusUnderReview'  => \__( 'Under review', 'allotment-manager-inspections' ),
				// Plot-list filter.
				'filterAll'     => \__( 'All', 'allotment-manager-inspections' ),
				'filterEmpty'   => \__( 'No plots match that filter.', 'allotment-manager-inspections' ),
				// Plot search. The three empty states are deliberately distinct:
				// "no plots match that filter" while the inspector is staring at
				// a plot number they just typed sends them looking for the wrong
				// cause.
				'searchPlaceholder'  => \__( 'Search plot or tenant…', 'allotment-manager-inspections' ),
				/* translators: %s: the search term the inspector typed. */
				'searchEmpty'        => \__( 'No plot or tenant matches “%s”.', 'allotment-manager-inspections' ),
				'searchFilterEmpty'  => \__( 'No plots match that search and filter together.', 'allotment-manager-inspections' ),
				'list'          => \__( 'List', 'allotment-manager-inspections' ),
				'map'           => \__( 'Map', 'allotment-manager-inspections' ),
				'notes'         => \__( 'Notes (shown to the member)', 'allotment-manager-inspections' ),
				'tenant'        => \__( 'Tenant', 'allotment-manager-inspections' ),
				'plot'          => \__( 'Plot', 'allotment-manager-inspections' ),
				'progress'      => \__( '%d of %d inspected', 'allotment-manager-inspections' ),
				// Issue tickbox labels (Site Inspection Procedure v3.0).
				// Inspectors tick what's wrong; severity (Cat 2 minor / Cat 3
				// significant) is set via the rating above. Severity-implied
				// items (uncultivated, derelict) are labelled to make their
				// Cat 3 implication clear.
				'issuesObserved'                  => \__( 'Issues observed', 'allotment-manager-inspections' ),
				'issueRubbish'                    => \__( 'Non-compostable rubbish', 'allotment-manager-inspections' ),
				'issueOvergrownWeeds'             => \__( 'Long grass or overgrown weeds', 'allotment-manager-inspections' ),
				'issueUncultivated'               => \__( 'Essentially no cultivation', 'allotment-manager-inspections' ),
				'issueDerelictStructures'         => \__( 'Derelict sheds or greenhouses', 'allotment-manager-inspections' ),
				'issueTenancyBreach'              => \__( 'Tenancy agreement breach', 'allotment-manager-inspections' ),
				'tenancyBreachDetailLabel'        => \__( 'Briefly describe the breach', 'allotment-manager-inspections' ),
				'tenancyBreachDetailPlaceholder'  => \__( 'e.g. subletting, structural change without consent', 'allotment-manager-inspections' ),
				// Map view.
				'inspectCta'    => \__( 'Inspect this plot', 'allotment-manager-inspections' ),
				'mapEmptyTitle' => \__( 'Map view not set up yet.', 'allotment-manager-inspections' ),
				'mapEmptyBody'  => \__( "The plots in this section need to be positioned in the admin's Map Editor before the map can render them. For now, use the list view.", 'allotment-manager-inspections' ),
				'mapOffline'    => \__( 'The map could not load. Connect to the internet once to cache it, then try again.', 'allotment-manager-inspections' ),
			],
		];
	}
}
