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
				'inspect'      => \wp_create_nonce( 'am_inspect_nonce' ),
				'recordFinding' => \wp_create_nonce( 'am_record_inspection_finding' ),
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
				'list'          => \__( 'List', 'allotment-manager-inspections' ),
				'map'           => \__( 'Map', 'allotment-manager-inspections' ),
				'notes'         => \__( 'Notes', 'allotment-manager-inspections' ),
				'tenant'        => \__( 'Tenant', 'allotment-manager-inspections' ),
				'plot'          => \__( 'Plot', 'allotment-manager-inspections' ),
				'progress'      => \__( '%d of %d inspected', 'allotment-manager-inspections' ),
			],
		];
	}
}
