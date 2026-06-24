<?php
/**
 * AJAX endpoints for the field inspector PWA.
 *
 * Read-only endpoints that surface the data the SPA needs:
 *   - am_inspect_list_rounds — active rounds the inspector can work on
 *   - am_inspect_list_plots  — plots in scope for a given round
 *   - am_inspect_get_plot    — single plot detail + current finding (if any)
 *
 * Plus one mutating endpoint:
 *   - am_inspect_save_finding — records a finding via the main plugin's
 *     Inspection_Finding model, single-inspector (field-PWA flow). It exists
 *     because the committee admin form's `am_inspection_record_finding`
 *     endpoint has a different nonce action + required fields, so the PWA
 *     could never post to it. Photo upload still uses the main plugin's
 *     `am_inspection_upload_photo` (its nonce action matches).
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
		\add_action( 'wp_ajax_am_inspect_save_finding', [ self::class, 'save_finding' ] );
		\add_action( 'wp_ajax_am_inspect_update_finding', [ self::class, 'update_finding' ] );
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
	 * POST action=am_inspect_save_finding
	 *
	 * Records a finding from the field PWA. The inspector's rating has already
	 * been translated client-side to a compliance category + status; we map it
	 * straight onto the main plugin's Inspection_Finding model, recording the
	 * LOGGED-IN user as the sole inspector. The committee's 2-inspector minimum
	 * is relaxed for this single-phone field flow via the
	 * `am_inspection_min_inspectors` filter.
	 *
	 * This replaces the old cross-plugin POST to `am_inspection_record_finding`
	 * (the committee admin form's endpoint), whose nonce action and required
	 * fields never matched what the PWA sends — so field findings never synced.
	 *
	 * @return void
	 */
	public static function save_finding(): void {
		self::authorise();

		$round_id  = isset( $_POST['round_id'] ) ? (int) $_POST['round_id'] : 0;
		$plot_id   = isset( $_POST['plot_id'] ) ? (int) $_POST['plot_id'] : 0;
		$member_id = isset( $_POST['member_id'] ) ? (int) $_POST['member_id'] : 0;
		if ( $round_id <= 0 || $plot_id <= 0 ) {
			\wp_send_json_error( [ 'message' => \__( 'Missing round or plot.', 'allotment-manager-inspections' ) ], 400 );
		}

		if ( ! \class_exists( '\AllotmentManager\Inspections\Inspection_Finding' ) ) {
			\wp_send_json_error( [ 'message' => \__( 'Inspections module unavailable.', 'allotment-manager-inspections' ) ], 500 );
		}

		$category = isset( $_POST['compliance_category'] ) ? \sanitize_key( $_POST['compliance_category'] ) : '';
		$status   = isset( $_POST['compliance_status'] ) ? \sanitize_key( $_POST['compliance_status'] ) : '';
		$notes    = isset( $_POST['findings_summary'] ) ? \sanitize_textarea_field( \wp_unslash( $_POST['findings_summary'] ) ) : '';
		$date     = ( isset( $_POST['inspection_date'] ) && \preg_match( '/^\d{4}-\d{2}-\d{2}$/', (string) $_POST['inspection_date'] ) )
			? (string) $_POST['inspection_date']
			: \current_time( 'Y-m-d' );

		$data = [
			'round_id'            => $round_id,
			'plot_id'             => $plot_id,
			'member_id'           => $member_id,
			'inspection_date'     => $date,
			'compliance_status'   => $status,
			'compliance_category' => '' !== $category ? $category : null,
			'findings_summary'    => $notes,
			// Single field inspector = the logged-in user.
			'inspector_user_ids'  => [ \get_current_user_id() ],
		];

		// Issue tickboxes — forward only keys actually sent so the schema's
		// tri-state (NULL = "not assessed") is preserved when a key is omitted.
		foreach ( [ 'has_rubbish', 'has_overgrown_weeds', 'has_uncultivated_areas', 'has_derelict_structures', 'has_tenancy_breach' ] as $key ) {
			if ( isset( $_POST[ $key ] ) ) {
				$data[ $key ] = ! empty( $_POST[ $key ] ) ? 1 : 0;
			}
		}
		if ( ! empty( $_POST['tenancy_breach_description'] ) ) {
			$data['tenancy_breach_description'] = \sanitize_text_field( \wp_unslash( $_POST['tenancy_breach_description'] ) );
		}

		// Committee-only note attached to a manual exemption / internal review.
		// The main plugin keeps it off the member portal; here it just rides
		// through. wp_unslash first so an apostrophe isn't stored as \'.
		if ( isset( $_POST['committee_notes'] ) ) {
			$data['committee_notes'] = \sanitize_textarea_field( \wp_unslash( $_POST['committee_notes'] ) );
		}

		// A field inspector often records just a rating (e.g. "Pass") with no
		// typed notes — but Inspection_Finding::create_finding() requires a
		// non-empty findings_summary, so those silently failed to sync. When no
		// summary was typed, synthesise a meaningful one from the rating + any
		// ticked issues so a rating-only finding still saves and reads sensibly.
		if ( '' === $notes ) {
			$data['findings_summary'] = self::auto_summary( $category, $data, $status );
		}

		// Relax the committee's 2-inspector minimum for this single-phone call,
		// then create via the main plugin's model (keeps its validation, the
		// UNIQUE round_plot guard, exemption + multi-plot logic, etc.).
		// try/finally so a throw inside create_finding can't leave the filter
		// registered for later calls in the same process (tests / CLI).
		$relax = static fn() => 1;
		\add_filter( 'am_inspection_min_inspectors', $relax );
		try {
			$result = \AllotmentManager\Inspections\Inspection_Finding::create_finding( $data );
		} finally {
			\remove_filter( 'am_inspection_min_inspectors', $relax );
		}

		if ( \is_wp_error( $result ) ) {
			\wp_send_json_error(
				[ 'message' => $result->get_error_message(), 'code' => $result->get_error_code() ],
				400
			);
		}

		\wp_send_json_success( [ 'finding_id' => (int) $result, 'id' => (int) $result ] );
	}

	/**
	 * POST action=am_inspect_update_finding
	 *
	 * Edits an EXISTING finding (to correct a mistake). Allowed for one of the
	 * finding's own recorded inspectors, or for chair/admin (the override —
	 * `edit_any_inspection_finding` cap / manage_options). Maps the payload
	 * exactly like save_finding and forwards to the main plugin's
	 * Inspection_Finding::update_finding(), which audit-logs the change and
	 * keeps the recorded inspector(s) immutable.
	 *
	 * @return void
	 */
	public static function update_finding(): void {
		self::authorise();

		$finding_id = isset( $_POST['finding_id'] ) ? (int) $_POST['finding_id'] : 0;
		if ( $finding_id <= 0 ) {
			\wp_send_json_error( [ 'message' => \__( 'Missing finding.', 'allotment-manager-inspections' ) ], 400 );
		}
		if ( ! \class_exists( '\AllotmentManager\Inspections\Inspection_Finding' ) ) {
			\wp_send_json_error( [ 'message' => \__( 'Inspections module unavailable.', 'allotment-manager-inspections' ) ], 500 );
		}

		// Authorise the edit: a recorded inspector on THIS finding, or the
		// chair/admin override. (The model enforces the baseline record cap.)
		global $wpdb;
		$findings_table = $wpdb->prefix . 'am_inspection_findings';
		$row = $wpdb->get_row( $wpdb->prepare( "SELECT inspector_user_ids, compliance_category, compliance_status, has_rubbish, has_overgrown_weeds, has_uncultivated_areas, has_derelict_structures, has_tenancy_breach FROM {$findings_table} WHERE id = %d", $finding_id ) );
		if ( ! $row ) {
			\wp_send_json_error( [ 'message' => \__( 'Finding not found.', 'allotment-manager-inspections' ) ], 404 );
		}
		$inspector_ids = ! empty( $row->inspector_user_ids ) ? array_map( 'intval', (array) json_decode( (string) $row->inspector_user_ids, true ) ) : [];
		$is_own      = \in_array( \get_current_user_id(), $inspector_ids, true );
		$is_override = \current_user_can( 'edit_any_inspection_finding' ) || \current_user_can( 'manage_options' );
		if ( ! $is_own && ! $is_override ) {
			\wp_send_json_error( [ 'message' => \__( 'You can only edit your own findings. Ask the chair to change another inspector’s finding.', 'allotment-manager-inspections' ) ], 403 );
		}

		$category = isset( $_POST['compliance_category'] ) ? \sanitize_key( $_POST['compliance_category'] ) : '';
		$status   = isset( $_POST['compliance_status'] ) ? \sanitize_key( $_POST['compliance_status'] ) : '';
		$notes    = isset( $_POST['findings_summary'] ) ? \sanitize_textarea_field( \wp_unslash( $_POST['findings_summary'] ) ) : '';

		$data = [ 'findings_summary' => $notes ];
		if ( '' !== $category ) {
			$data['compliance_category'] = $category;
		}
		if ( '' !== $status ) {
			$data['compliance_status'] = $status;
		}
		foreach ( [ 'has_rubbish', 'has_overgrown_weeds', 'has_uncultivated_areas', 'has_derelict_structures', 'has_tenancy_breach' ] as $key ) {
			if ( isset( $_POST[ $key ] ) ) {
				$data[ $key ] = ! empty( $_POST[ $key ] ) ? 1 : 0;
			}
		}
		if ( isset( $_POST['tenancy_breach_description'] ) ) {
			$data['tenancy_breach_description'] = \sanitize_text_field( \wp_unslash( $_POST['tenancy_breach_description'] ) );
		}
		if ( isset( $_POST['committee_notes'] ) ) {
			$data['committee_notes'] = \sanitize_textarea_field( \wp_unslash( $_POST['committee_notes'] ) );
		}

		// Stale auto-summary guard. The editor pre-fills the notes box with the
		// existing summary, so an inspector who changes only the RATING (and
		// leaves the notes) would otherwise keep a summary that now contradicts
		// the new verdict (e.g. category_2 reading "Pass — no issues recorded.").
		// If the submitted notes are EXACTLY the auto-summary the CURRENT stored
		// verdict would produce, the inspector never hand-typed them — clear so
		// the block below regenerates one for the NEW verdict. Hand-written notes
		// (which won't match) are preserved untouched.
		if ( '' !== $notes ) {
			$before_issue = [];
			foreach ( [ 'has_rubbish', 'has_overgrown_weeds', 'has_uncultivated_areas', 'has_derelict_structures', 'has_tenancy_breach' ] as $bk ) {
				$before_issue[ $bk ] = ! empty( $row->$bk ) ? 1 : 0;
			}
			if ( $notes === self::auto_summary( (string) ( $row->compliance_category ?? '' ), $before_issue, (string) ( $row->compliance_status ?? '' ) ) ) {
				$notes = '';
			}
		}
		if ( '' === $notes ) {
			$data['findings_summary'] = self::auto_summary( $category, $data, $status );
		}

		$result = \AllotmentManager\Inspections\Inspection_Finding::update_finding( $finding_id, $data );
		if ( \is_wp_error( $result ) ) {
			\wp_send_json_error( [ 'message' => $result->get_error_message(), 'code' => $result->get_error_code() ], 400 );
		}

		\wp_send_json_success( [ 'finding_id' => $finding_id, 'id' => $finding_id, 'updated' => true ] );
	}

	/**
	 * Synthesise a findings summary from the rating + ticked issues when the
	 * inspector typed none — a rating-only verdict still needs a non-empty
	 * summary for Inspection_Finding. Shared by save_finding + update_finding.
	 *
	 * @param string $category Compliance category (category_1|2|3).
	 * @param array  $data     Update data carrying the has_* issue flags.
	 * @return string
	 */
	private static function auto_summary( string $category, array $data, string $status = '' ): string {
		$issue_labels = [
			'has_rubbish'             => \__( 'non-compostable rubbish', 'allotment-manager-inspections' ),
			'has_overgrown_weeds'     => \__( 'overgrown weeds', 'allotment-manager-inspections' ),
			'has_uncultivated_areas'  => \__( 'essentially no cultivation visible', 'allotment-manager-inspections' ),
			'has_derelict_structures' => \__( 'derelict structures', 'allotment-manager-inspections' ),
			'has_tenancy_breach'      => \__( 'tenancy agreement breach', 'allotment-manager-inspections' ),
		];
		$ticked = [];
		foreach ( $issue_labels as $issue_key => $issue_label ) {
			if ( ! empty( $data[ $issue_key ] ) ) {
				$ticked[] = $issue_label;
			}
		}
		$base = [
			'category_1' => \__( 'Pass — no issues recorded.', 'allotment-manager-inspections' ),
			'category_2' => \__( 'Minor corrections needed.', 'allotment-manager-inspections' ),
			'category_3' => \__( 'Major issues — action required.', 'allotment-manager-inspections' ),
		];
		// Exemption / internal-review findings carry no category, so fall back
		// to a status-specific line rather than the generic default.
		$status_base = [
			'exempt'          => \__( 'Plot exempt this round.', 'allotment-manager-inspections' ),
			'internal_review' => \__( 'Referred for committee review.', 'allotment-manager-inspections' ),
		];
		$summary = $base[ $category ] ?? $status_base[ $status ] ?? \__( 'Inspection recorded.', 'allotment-manager-inspections' );
		if ( $ticked ) {
			$summary .= ' ' . \sprintf(
				/* translators: %s: comma-separated list of ticked issues */
				\__( 'Issues observed: %s.', 'allotment-manager-inspections' ),
				\implode( ', ', $ticked )
			);
		}
		return $summary;
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
		$findings_table = $wpdb->prefix . 'am_inspection_findings';
		$map_obj_table  = $wpdb->prefix . 'am_map_objects';

		// Load round meta.
		$round = $wpdb->get_row(
			$wpdb->prepare( "SELECT id, round_number, site_section, inspection_type, parent_round_id, status FROM {$rounds_table} WHERE id = %d", $round_id )
		);
		if ( ! $round ) {
			\wp_send_json_error( [ 'message' => \__( 'Round not found.', 'allotment-manager-inspections' ) ], 404 );
		}

		// Resolve each plot's current holder from the active tenancy assignment
		// (rather than the stale-prone current_member_id). Shared with get_plot so
		// the list and the detail view always resolve holders identically — see
		// holder_join_sql() for the full rationale. Exposes `asg` + members alias `m`.
		$holder_join = self::holder_join_sql();

		// Build the plot list. For a followup round we INNER JOIN against the
		// parent round's findings (only plots that scored 2 or 3 then are in
		// scope now). For a primary round we list all plots in the section.
		if ( 'followup' === $round->inspection_type && $round->parent_round_id ) {
			$sql = $wpdb->prepare(
				"SELECT
					p.id,
					p.plot_number,
					p.section,
					COALESCE(asg.member_id, p.current_member_id) AS effective_member_id,
					asg.start_date AS assignment_start_date,
					m.first_name,
					m.last_name,
					mo.latitude,
					mo.longitude,
					mo.width,
					mo.height,
					mo.rotation_angle,
					curr.id AS current_finding_id,
					curr.compliance_category AS current_category,
					prev.compliance_category AS previous_category
				FROM {$findings_table} prev
				INNER JOIN {$plots_table} p ON p.id = prev.plot_id
				{$holder_join}
				LEFT JOIN {$map_obj_table} mo ON mo.plot_id = p.id AND mo.object_type = 'plot'
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
					COALESCE(asg.member_id, p.current_member_id) AS effective_member_id,
					asg.start_date AS assignment_start_date,
					m.first_name,
					m.last_name,
					mo.latitude,
					mo.longitude,
					mo.width,
					mo.height,
					mo.rotation_angle,
					curr.id AS current_finding_id,
					curr.compliance_category AS current_category,
					NULL AS previous_category
				FROM {$plots_table} p
				{$holder_join}
				LEFT JOIN {$map_obj_table} mo ON mo.plot_id = p.id AND mo.object_type = 'plot'
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

		$plots = array_map( [ self::class, 'format_plot_row' ], $rows ?: [] );

		$tile = self::tile_config();

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
				'map'   => [ 'tile' => $tile ],
			]
		);
	}

	/**
	 * Map a plots query row to the SPA's plot shape, including the map centroid.
	 *
	 * @param object $row Row from the list_plots query.
	 * @return array<string,mixed>
	 */
	private static function format_plot_row( $row ): array {
		$first = trim( (string) ( $row->first_name ?? '' ) );
		$last  = trim( (string) ( $row->last_name ?? '' ) );
		$name  = trim( $first . ' ' . $last );

		// Effective holder: prefer the SQL-resolved effective_member_id
		// (active-assignment member ?? current_member_id). Fall back to
		// current_member_id for older-shaped rows (e.g. unit-test fixtures that
		// don't carry the resolved column). 0 = genuinely vacant.
		$member_id = ! empty( $row->effective_member_id )
			? (int) $row->effective_member_id
			: ( ! empty( $row->current_member_id ) ? (int) $row->current_member_id : 0 );

		$start_date = ! empty( $row->assignment_start_date ) ? (string) $row->assignment_start_date : null;

		return [
			'id'                => (int) $row->id,
			'plotNumber'        => $row->plot_number,
			'section'           => $row->section,
			'memberId'          => $member_id ?: null,
			'tenantName'        => '' !== $name ? $name : null,
			// Occupancy state for the field UI: a vacant plot is shown but not
			// inspectable (recording would fail — create_finding requires a
			// member); a new tenant is shown flagged "exempt" (the server
			// auto-exempts them, so it's recordable but no notice is issued).
			'isVacant'          => 0 === $member_id,
			'isNewTenant'       => self::is_new_tenant( $member_id, $start_date ),
			'tenantStartDate'   => $start_date,
			'currentFindingId'  => $row->current_finding_id ? (int) $row->current_finding_id : null,
			'currentCategory'   => $row->current_category,   // category_1|2|3 or null
			'previousCategory'  => $row->previous_category,  // for followup rounds, the parent finding's category
			// Plot footprint from the admin Map Editor (wp_am_map_objects): the
			// centroid plus the box width/height (pixels at zoom 19) and rotation
			// (degrees). The map draws the plot's real rotated rectangle from
			// these so it scales with the satellite imagery instead of a fixed
			// dot. All null when the plot hasn't been positioned yet — the Map
			// view then falls back to its "set up in Map Editor" empty state.
			'lat'               => null === $row->latitude ? null : (float) $row->latitude,
			'lng'               => null === $row->longitude ? null : (float) $row->longitude,
			'width'             => null === ( $row->width ?? null ) ? null : (int) $row->width,
			'height'            => null === ( $row->height ?? null ) ? null : (int) $row->height,
			'rotation'          => null === ( $row->rotation_angle ?? null ) ? null : (float) $row->rotation_angle,
		];
	}

	/**
	 * SQL JOIN fragment that resolves a plot's CURRENT holder from the active
	 * tenancy assignment — the authoritative tenancy record — rather than the
	 * denormalised wp_am_plots.current_member_id, which goes stale when a plot is
	 * reassigned (left NULL, or still pointing at the departed tenant: the known
	 * "orphaned-allocated" gap, cf. `wp am resync_plot_holders`).
	 *
	 * The derived table returns one row per plot — the member id + start_date of
	 * the most recent active, non-deleted assignment (GROUP_CONCAT/SUBSTRING_INDEX
	 * picks the latest by start_date, MAX(start_date) is its date). The member
	 * join then PREFERS the active assignment and falls back to current_member_id
	 * only when there's no active assignment, so the resolved name + start_date
	 * always come from the same record. A plot with neither is genuinely vacant.
	 *
	 * Assumes the outer query aliases the plots table `p`. Exposes `asg.member_id`,
	 * `asg.start_date`, and the members alias `m`. Carries no `%` placeholders so
	 * it interpolates safely into a prepared statement. Shared by list_plots +
	 * get_plot so the two can never resolve a plot's holder differently.
	 *
	 * @return string
	 */
	private static function holder_join_sql(): string {
		global $wpdb;
		$assign_table  = $wpdb->prefix . 'am_plot_assignments';
		$members_table = $wpdb->prefix . 'mm_members';
		return "LEFT JOIN (
				SELECT plot_id,
					CAST(SUBSTRING_INDEX(GROUP_CONCAT(member_id ORDER BY start_date DESC, id DESC), ',', 1) AS UNSIGNED) AS member_id,
					MAX(start_date) AS start_date
				FROM {$assign_table}
				WHERE status = 'active' AND deleted_at IS NULL
				GROUP BY plot_id
			) asg ON asg.plot_id = p.id
			LEFT JOIN {$members_table} m ON m.id = COALESCE(asg.member_id, p.current_member_id)";
	}

	/**
	 * Whether a plot's current holder is a "new tenant" — started after the
	 * 1 March cutoff and therefore exempt from compliance notices this round.
	 *
	 * UI HINT ONLY. The authoritative exemption runs server-side in
	 * create_finding() (Inspection_Finding::check_new_tenant_exemption, keyed off
	 * the round's inspection DATE year), so a slightly stale badge never changes
	 * the recorded verdict. This badge approximates that with the CURRENT calendar
	 * year — exact for an in-season round, and good enough for a hint where the
	 * round's inspection date isn't loaded here. The month/day (1 March) tracks
	 * Inspection_Finding::NEW_TENANT_CUTOFF — keep them in step if that policy
	 * date ever changes.
	 *
	 * @param int         $member_id  Effective member id (0 = vacant).
	 * @param string|null $start_date Active assignment start date (Y-m-d) or null.
	 * @return bool
	 */
	private static function is_new_tenant( int $member_id, ?string $start_date ): bool {
		if ( $member_id <= 0 || empty( $start_date ) ) {
			return false;
		}
		$cutoff = \current_time( 'Y' ) . '-03-01';
		return $start_date > $cutoff;
	}

	/**
	 * Tile-layer config for the Map view. Resolved via the same
	 * `am_map_tile_layer` filter the main plugin's maps use, so an admin's
	 * paid-tile-provider override applies here too. Shape mirrors what
	 * member-map-view.js consumes (url/attribution/maxZoom/subdomains).
	 *
	 * @return array<string,mixed>
	 */
	private static function tile_config(): array {
		return \apply_filters(
			'am_map_tile_layer',
			[
				'url'           => 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
				'attribution'   => '© OpenStreetMap contributors',
				'maxNativeZoom' => 19,
				'maxZoom'       => 19,
				'subdomains'    => [ 'a', 'b', 'c' ],
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
		$findings_table = $wpdb->prefix . 'am_inspection_findings';
		$photos_table   = $wpdb->prefix . 'am_inspection_photos';

		// Resolve the holder from the active assignment (see holder_join_sql) so a
		// freshly-assigned tenant shows by name and the correct member_id flows
		// into save_finding. Same join as list_plots — single source of truth.
		$holder_join = self::holder_join_sql();
		$row = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT
					p.id,
					p.plot_number,
					p.section,
					COALESCE(asg.member_id, p.current_member_id) AS effective_member_id,
					asg.start_date AS assignment_start_date,
					m.first_name,
					m.last_name,
					m.email,
					m.membership_number
				FROM {$plots_table} p
				{$holder_join}
				WHERE p.id = %d AND (p.deleted_at IS NULL)",
				$plot_id
			)
		);
		if ( ! $row ) {
			\wp_send_json_error( [ 'message' => \__( 'Plot not found.', 'allotment-manager-inspections' ) ], 404 );
		}

		$finding = $wpdb->get_row(
			$wpdb->prepare(
				"SELECT
					id, compliance_category, compliance_status, findings_summary, committee_notes, requires_followup,
					has_rubbish, has_overgrown_weeds, has_uncultivated_areas,
					has_derelict_structures, has_tenancy_breach, tenancy_breach_description,
					inspector_user_ids, inspector_names, created_at, updated_at
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

		// Edit policy + warn metadata for an existing finding. A finding may be
		// edited by one of its recorded inspectors, or by chair/admin (the
		// override). `hasNotice` lets the app WARN before changing a finding a
		// notice was already sent for; `edited` flags a previously-corrected one.
		$can_edit    = false;
		$recorded_by = null;
		$has_notice  = false;
		$edited      = false;
		$edited_at   = null;
		if ( $finding ) {
			$inspector_ids = ! empty( $finding->inspector_user_ids ) ? (array) json_decode( (string) $finding->inspector_user_ids, true ) : [];
			$inspector_ids = array_map( 'intval', $inspector_ids );
			$can_edit = \in_array( \get_current_user_id(), $inspector_ids, true )
				|| \current_user_can( 'edit_any_inspection_finding' )
				|| \current_user_can( 'manage_options' );
			$recorded_by = $finding->inspector_names ? $finding->inspector_names : null;
			// Only needed to warn before an EDIT — skip the COUNT query for
			// read-only viewers (the hot path is opening plots you can't edit).
			$has_notice  = $can_edit
				&& \class_exists( '\AllotmentManager\Inspections\Inspection_Finding' )
				&& \AllotmentManager\Inspections\Inspection_Finding::finding_has_notice( (int) $finding->id );
			$edited = ! empty( $finding->updated_at ) && ! empty( $finding->created_at )
				&& \strtotime( (string) $finding->updated_at ) > \strtotime( (string) $finding->created_at ) + 2;
			$edited_at = $edited ? $finding->updated_at : null;
		}

		$first = trim( (string) ( $row->first_name ?? '' ) );
		$last  = trim( (string) ( $row->last_name ?? '' ) );
		$name  = trim( $first . ' ' . $last );

		$effective_member_id = ! empty( $row->effective_member_id ) ? (int) $row->effective_member_id : 0;
		$start_date          = ! empty( $row->assignment_start_date ) ? (string) $row->assignment_start_date : null;

		\wp_send_json_success(
			[
				'plot'    => [
					'id'                => (int) $row->id,
					'plotNumber'        => $row->plot_number,
					'section'           => $row->section,
					'memberId'          => $effective_member_id ?: null,
					'tenantName'        => '' !== $name ? $name : null,
					'membershipNumber'  => $row->membership_number,
					// Occupancy state — see format_plot_row. Vacant → not
					// inspectable client-side; new tenant → shown flagged, the
					// server auto-exempts so no notice is issued.
					'isVacant'          => 0 === $effective_member_id,
					'isNewTenant'       => self::is_new_tenant( $effective_member_id, $start_date ),
					'tenantStartDate'   => $start_date,
				],
				'finding' => $finding ? [
					'id'                 => (int) $finding->id,
					'complianceCategory' => $finding->compliance_category,
					'complianceStatus'   => $finding->compliance_status,
					'findingsSummary'    => $finding->findings_summary,
					// Committee-only note (manual exemption / internal review).
					// The PWA is a committee tool, so it's fine to return here;
					// the main plugin keeps it off the member portal.
					'committeeNotes'     => $finding->committee_notes,
					'requiresFollowup'   => (bool) $finding->requires_followup,
					// Issue-tickbox columns (DB 2.11.2). Null = inspector
					// didn't assess this aspect; 0/false = explicitly
					// recorded "no issue present"; 1/true = ticked.
					// Cast preserves the tri-state: null stays null, the
					// rest become bool — the finding-editor pre-populates
					// from `hasX !== undefined ? !!hasX : null`.
					'hasRubbish'              => null === $finding->has_rubbish              ? null : (bool) $finding->has_rubbish,
					'hasOvergrownWeeds'       => null === $finding->has_overgrown_weeds      ? null : (bool) $finding->has_overgrown_weeds,
					'hasUncultivatedAreas'    => null === $finding->has_uncultivated_areas   ? null : (bool) $finding->has_uncultivated_areas,
					'hasDerelictStructures'   => null === $finding->has_derelict_structures  ? null : (bool) $finding->has_derelict_structures,
					'hasTenancyBreach'        => null === $finding->has_tenancy_breach       ? null : (bool) $finding->has_tenancy_breach,
					'tenancyBreachDescription' => $finding->tenancy_breach_description,
						'canEdit'    => $can_edit,
						'recordedBy' => $recorded_by,
						'hasNotice'  => $has_notice,
						'edited'     => $edited,
						'editedAt'   => $edited_at,
				] : null,
				'photos'  => $photos,
			]
		);
	}
}
