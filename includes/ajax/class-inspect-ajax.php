<?php
/**
 * AJAX endpoints for the field inspector PWA.
 *
 * Three read-only endpoints that surface the data the SPA needs:
 *   - am_inspect_list_rounds — active rounds the inspector can work on
 *   - am_inspect_list_plots  — plots in scope for a given round
 *   - am_inspect_get_plot    — single plot detail + current finding (if any)
 *
 * The mutating endpoints (save finding, upload photo) are the existing
 * `am_inspection_record_finding` and `am_inspection_upload_photo` in the
 * main plugin — we do not duplicate them here.
 *
 * @package AllotmentManagerInspections
 */

namespace AllotmentManagerInspections;

defined( 'ABSPATH' ) || exit;

/**
 * AJAX endpoint registrar + handlers.
 */
final class Inspect_Ajax {

	/**
	 * Wire up the three actions.
	 *
	 * @return void
	 */
	public static function register(): void {
		\add_action( 'wp_ajax_am_inspect_list_rounds', [ self::class, 'list_rounds' ] );
		\add_action( 'wp_ajax_am_inspect_list_plots', [ self::class, 'list_plots' ] );
		\add_action( 'wp_ajax_am_inspect_get_plot', [ self::class, 'get_plot' ] );
	}

	/**
	 * Shared gate: verify nonce + capability. Returns true if the request may
	 * proceed; otherwise sends a JSON error and halts.
	 *
	 * @return void
	 */
	private static function authorise(): void {
		if ( ! \check_ajax_referer( 'am_inspect_nonce', 'nonce', false ) ) {
			\wp_send_json_error( [ 'message' => \__( 'Invalid security token. Please refresh and try again.', 'allotment-manager-inspections' ) ], 403 );
		}
		if ( ! \current_user_can( AMI_CAPABILITY ) ) {
			\wp_send_json_error( [ 'message' => \__( 'You do not have inspector permissions.', 'allotment-manager-inspections' ) ], 403 );
		}
	}

	/**
	 * GET /wp-admin/admin-ajax.php?action=am_inspect_list_rounds
	 *
	 * @return void
	 */
	public static function list_rounds(): void {
		self::authorise();

		global $wpdb;

		$rounds_table   = $wpdb->prefix . 'am_inspection_rounds';
		$findings_table = $wpdb->prefix . 'am_inspection_findings';

		// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$rows = $wpdb->get_results(
			"SELECT
				r.id,
				r.round_number,
				r.inspection_type,
				r.parent_round_id,
				r.site_section,
				r.status,
				r.scheduled_start_date,
				r.scheduled_end_date,
				r.total_plots_count,
				r.inspected_plots_count,
				(SELECT COUNT(*) FROM {$findings_table} f WHERE f.round_id = r.id) AS findings_count
			FROM {$rounds_table} r
			WHERE r.status IN ('scheduled', 'in_progress')
			ORDER BY r.scheduled_start_date DESC, r.id DESC"
		);
		// phpcs:enable

		$rounds = array_map(
			static function ( $row ) {
				return [
					'id'                  => (int) $row->id,
					'roundNumber'         => $row->round_number,
					'inspectionType'      => $row->inspection_type,
					'parentRoundId'       => $row->parent_round_id ? (int) $row->parent_round_id : null,
					'siteSection'         => $row->site_section,
					'status'              => $row->status,
					'scheduledStartDate'  => $row->scheduled_start_date,
					'scheduledEndDate'    => $row->scheduled_end_date,
					'totalPlots'          => (int) $row->total_plots_count,
					'inspectedPlots'      => (int) max( (int) $row->inspected_plots_count, (int) $row->findings_count ),
				];
			},
			$rows ?: []
		);

		\wp_send_json_success( [ 'rounds' => $rounds ] );
	}

	/**
	 * GET ?action=am_inspect_list_plots&round_id=N
	 *
	 * For a primary round: all plots in r.site_section.
	 * For a followup round: only plots that had category_2 or category_3 in the
	 * parent round.
	 *
	 * @return void
	 */
	public static function list_plots(): void {
		self::authorise();

		$round_id = isset( $_GET['round_id'] ) ? (int) $_GET['round_id'] : 0;
		if ( $round_id <= 0 ) {
			\wp_send_json_error( [ 'message' => \__( 'Missing round_id.', 'allotment-manager-inspections' ) ], 400 );
		}

		global $wpdb;
		$rounds_table   = $wpdb->prefix . 'am_inspection_rounds';
		$plots_table    = $wpdb->prefix . 'am_plots';
		$members_table  = $wpdb->prefix . 'mm_members';
		$findings_table = $wpdb->prefix . 'am_inspection_findings';

		// Load round meta.
		$round = $wpdb->get_row(
			$wpdb->prepare( "SELECT id, round_number, site_section, inspection_type, parent_round_id, status FROM {$rounds_table} WHERE id = %d", $round_id )
		);
		if ( ! $round ) {
			\wp_send_json_error( [ 'message' => \__( 'Round not found.', 'allotment-manager-inspections' ) ], 404 );
		}

		// Build the plot list. For a followup round we INNER JOIN against the
		// parent round's findings (only plots that scored 2 or 3 then are in
		// scope now). For a primary round we list all plots in the section.
		if ( 'followup' === $round->inspection_type && $round->parent_round_id ) {
			$sql = $wpdb->prepare(
				"SELECT
					p.id,
					p.plot_number,
					p.section,
					p.current_member_id,
					m.first_name,
					m.last_name,
					curr.id AS current_finding_id,
					curr.compliance_category AS current_category,
					prev.compliance_category AS previous_category
				FROM {$findings_table} prev
				INNER JOIN {$plots_table} p ON p.id = prev.plot_id
				LEFT JOIN {$members_table} m ON m.id = p.current_member_id
				LEFT JOIN {$findings_table} curr ON curr.plot_id = p.id AND curr.round_id = %d
				WHERE prev.round_id = %d
				  AND prev.compliance_category IN ('category_2', 'category_3')
				  AND (p.deleted_at IS NULL)
				ORDER BY p.plot_number",
				$round_id,
				(int) $round->parent_round_id
			);
		} else {
			$sql = $wpdb->prepare(
				"SELECT
					p.id,
					p.plot_number,
					p.section,
					p.current_member_id,
					m.first_name,
					m.last_name,
					curr.id AS current_finding_id,
					curr.compliance_category AS current_category,
					NULL AS previous_category
				FROM {$plots_table} p
				LEFT JOIN {$members_table} m ON m.id = p.current_member_id
				LEFT JOIN {$findings_table} curr ON curr.plot_id = p.id AND curr.round_id = %d
				WHERE p.section = %s
				  AND (p.deleted_at IS NULL)
				ORDER BY LENGTH(p.plot_number), p.plot_number",
				$round_id,
				$round->site_section
			);
		}

		// phpcs:disable WordPress.DB.PreparedSQL.NotPrepared
		$rows = $wpdb->get_results( $sql );
		// phpcs:enable

		$plots = array_map(
			static function ( $row ) {
				$first = trim( (string) ( $row->first_name ?? '' ) );
				$last  = trim( (string) ( $row->last_name ?? '' ) );
				$name  = trim( $first . ' ' . $last );

				return [
					'id'                => (int) $row->id,
					'plotNumber'        => $row->plot_number,
					'section'           => $row->section,
					'memberId'          => $row->current_member_id ? (int) $row->current_member_id : null,
					'tenantName'        => '' !== $name ? $name : null,
					'currentFindingId'  => $row->current_finding_id ? (int) $row->current_finding_id : null,
					'currentCategory'   => $row->current_category,   // category_1|2|3 or null
					'previousCategory'  => $row->previous_category,  // for followup rounds, the parent finding's category
				];
			},
			$rows ?: []
		);

		\wp_send_json_success(
			[
				'round' => [
					'id'             => (int) $round->id,
					'roundNumber'    => $round->round_number,
					'siteSection'    => $round->site_section,
					'inspectionType' => $round->inspection_type,
					'parentRoundId'  => $round->parent_round_id ? (int) $round->parent_round_id : null,
					'status'         => $round->status,
				],
				'plots' => $plots,
			]
		);
	}

	/**
	 * GET ?action=am_inspect_get_plot&plot_id=N&round_id=M
	 *
	 * Returns a single plot's detail + any finding already recorded in this
	 * round + photos attached to that finding.
	 *
	 * @return void
	 */
	public static function get_plot(): void {
		self::authorise();

		$plot_id  = isset( $_GET['plot_id'] ) ? (int) $_GET['plot_id'] : 0;
		$round_id = isset( $_GET['round_id'] ) ? (int) $_GET['round_id'] : 0;
		if ( $plot_id <= 0 || $round_id <= 0 ) {
			\wp_send_json_error( [ 'message' => \__( 'Missing plot_id or round_id.', 'allotment-manager-inspections' ) ], 400 );
		}

		global $wpdb;
		$plots_table    = $wpdb->prefix . 'am_plots';
		$members_table  = $wpdb->prefix . 'mm_members';
		$findings_table = $wpdb->prefix . 'am_inspection_findings';
		$photos_table   = $wpdb->prefix . 'am_inspection_photos';

		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT
					p.id,
					p.plot_number,
					p.section,
					p.current_member_id,
					m.first_name,
					m.last_name,
					m.email,
					m.membership_number
				FROM {$plots_table} p
				LEFT JOIN {$members_table} m ON m.id = p.current_member_id
				WHERE p.id = %d AND (p.deleted_at IS NULL)",
				$plot_id
			)
		);
		if ( ! $row ) {
			\wp_send_json_error( [ 'message' => \__( 'Plot not found.', 'allotment-manager-inspections' ) ], 404 );
		}

		$finding = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT id, compliance_category, compliance_status, findings_summary, requires_followup
				FROM {$findings_table}
				WHERE plot_id = %d AND round_id = %d
				LIMIT 1",
				$plot_id,
				$round_id
			)
		);

		$photos = [];
		if ( $finding ) {
			$photo_rows = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT id, google_drive_url, google_drive_thumbnail_url, photo_caption, photo_order
					FROM {$photos_table}
					WHERE finding_id = %d AND deleted_at IS NULL
					ORDER BY photo_order ASC, id ASC",
					(int) $finding->id
				)
			);
			$photos = array_map(
				static fn( $p ) => [
					'id'           => (int) $p->id,
					'url'          => $p->google_drive_url,
					'thumbnailUrl' => $p->google_drive_thumbnail_url,
					'caption'      => $p->photo_caption,
					'order'        => (int) $p->photo_order,
				],
				$photo_rows ?: []
			);
		}

		$first = trim( (string) ( $row->first_name ?? '' ) );
		$last  = trim( (string) ( $row->last_name ?? '' ) );
		$name  = trim( $first . ' ' . $last );

		\wp_send_json_success(
			[
				'plot'    => [
					'id'                => (int) $row->id,
					'plotNumber'        => $row->plot_number,
					'section'           => $row->section,
					'memberId'          => $row->current_member_id ? (int) $row->current_member_id : null,
					'tenantName'        => '' !== $name ? $name : null,
					'membershipNumber'  => $row->membership_number,
				],
				'finding' => $finding ? [
					'id'                 => (int) $finding->id,
					'complianceCategory' => $finding->compliance_category,
					'complianceStatus'   => $finding->compliance_status,
					'findingsSummary'    => $finding->findings_summary,
					'requiresFollowup'   => (bool) $finding->requires_followup,
				] : null,
				'photos'  => $photos,
			]
		);
	}
}
