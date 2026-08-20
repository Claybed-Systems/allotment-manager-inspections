<?php
/**
 * Which plots a round hands the inspector, and in what order.
 *
 * A round is one per (year, site) and covers its whole section, so every plot
 * in it is listed and recordable. The follow-up ROUND that re-inspected only a
 * flagged subset is gone (#883): a re-inspection is visit 2 within the same
 * round, and the tests that pinned the old scoping went with it.
 *
 * This suite builds the tables the query touches by hand. The main-plugin
 * migrations do not run in this repo's test env (see test-inspect-list-plots.php),
 * and the findings table is SELF-joined here (`prev` + `curr`), which rules out
 * TEMPORARY tables — MySQL cannot open one twice in a single query.
 *
 * @package AllotmentManagerInspections
 */

use AllotmentManagerInspections\Inspect_Ajax;

class Test_Inspect_Followup_Scope extends WP_UnitTestCase {

	private static array $tables = array();

	/**
	 * Only the tables THIS class created, so teardown never drops a real one.
	 *
	 * Both environments are live: CI gives this repo a bare WordPress install
	 * with no main-plugin schema, so the fixtures below are created; but a
	 * developer pointing WP_TESTS_DIR at the monorepo's own test database finds
	 * the REAL tables already there, `CREATE TABLE IF NOT EXISTS` no-ops, and a
	 * blanket DROP in teardown would take the genuine schema with it. (Foreign
	 * keys refused the drop the first time this was run that way; that was luck,
	 * not a design.)
	 *
	 * @var array<int,string>
	 */
	private static array $created = array();

	public static function setUpBeforeClass(): void {
		parent::setUpBeforeClass();
		global $wpdb;

		self::$tables = array(
			'plots'       => $wpdb->prefix . 'am_plots',
			'findings'    => $wpdb->prefix . 'am_inspection_findings',
			'map_objects' => $wpdb->prefix . 'am_map_objects',
			'assignments' => $wpdb->prefix . 'am_plot_assignments',
			'members'     => $wpdb->prefix . 'mm_members',
			'photos'      => $wpdb->prefix . 'am_inspection_photos',
		);

		// Only the columns the plot-list query reads, and column names/types that
		// match the real schema so the same fixtures insert cleanly against
		// either. Deliberately no foreign keys: this exercises the WHERE clause,
		// not the main plugin's referential integrity.
		$ddl = array(
			'plots'       => "(
				id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				plot_number varchar(50) NOT NULL,
				section varchar(50) NOT NULL,
				current_member_id bigint(20) UNSIGNED DEFAULT NULL,
				deleted_at datetime DEFAULT NULL,
				PRIMARY KEY (id)
			)",
			// The has_* / description / date columns are here for
			// previous_finding(), which reads the first round's WORK ORDER (#43).
			// They matter more than they look: CI creates these fixture tables
			// against a bare WordPress with no main-plugin schema, so a column
			// missing here is a query error in CI only — green locally, red there.
			'findings'    => "(
				id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				round_id bigint(20) UNSIGNED NOT NULL,
				plot_id bigint(20) UNSIGNED NOT NULL,
				subdivision_identifier varchar(10) NOT NULL DEFAULT '',
				visit_sequence tinyint(3) UNSIGNED NOT NULL DEFAULT 1,
				compliance_status varchar(30) NOT NULL DEFAULT 'compliant',
				compliance_category varchar(30) DEFAULT NULL,
				findings_summary text,
				inspector_user_ids text,
				inspector_names varchar(255) DEFAULT NULL,
				inspection_date date DEFAULT NULL,
				cultivation_percentage decimal(5,2) DEFAULT NULL,
				has_rubbish tinyint(1) DEFAULT NULL,
				has_overgrown_weeds tinyint(1) DEFAULT NULL,
				has_uncultivated_areas tinyint(1) DEFAULT NULL,
				has_derelict_structures tinyint(1) DEFAULT NULL,
				has_tenancy_breach tinyint(1) DEFAULT NULL,
				tenancy_breach_description text,
				requires_followup tinyint(1) NOT NULL DEFAULT 0,
				voided_at datetime DEFAULT NULL,
				PRIMARY KEY (id)
			)",
			// finding_photos() joins here for the first round's before-pictures.
			'photos'      => "(
				id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				finding_id bigint(20) UNSIGNED NOT NULL,
				google_drive_url varchar(500) DEFAULT NULL,
				google_drive_thumbnail_url varchar(500) DEFAULT NULL,
				photo_caption varchar(255) DEFAULT NULL,
				photo_order int(11) NOT NULL DEFAULT 0,
				deleted_at datetime DEFAULT NULL,
				PRIMARY KEY (id)
			)",
			'map_objects' => "(
				id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				plot_id bigint(20) UNSIGNED DEFAULT NULL,
				object_type varchar(30) NOT NULL DEFAULT 'plot',
				latitude decimal(10,8) DEFAULT NULL,
				longitude decimal(11,8) DEFAULT NULL,
				width int DEFAULT NULL,
				height int DEFAULT NULL,
				rotation_angle decimal(6,2) DEFAULT NULL,
				PRIMARY KEY (id)
			)",
			'assignments' => "(
				id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				plot_id bigint(20) UNSIGNED NOT NULL,
				member_id bigint(20) UNSIGNED NOT NULL,
				start_date date NOT NULL,
				status varchar(20) NOT NULL DEFAULT 'active',
				deleted_at datetime DEFAULT NULL,
				PRIMARY KEY (id)
			)",
			'members'     => "(
				id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id bigint(20) UNSIGNED DEFAULT NULL,
				first_name varchar(100) DEFAULT NULL,
				last_name varchar(100) DEFAULT NULL,
				PRIMARY KEY (id)
			)",
		);

		foreach ( $ddl as $key => $columns ) {
			$table = self::$tables[ $key ];
			$found = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) );
			if ( $found ) {
				continue; // The real schema is present — use it, and leave it alone.
			}
			$wpdb->query( "CREATE TABLE {$table} {$columns}" );
			self::$created[] = $table;
		}

		// A fixture table left behind by an earlier run is REUSED above, not
		// recreated, so a column added to the DDL never reaches it and every
		// query naming that column fails with "Unknown column" — against a table
		// this suite created itself. Backfill rather than drop: the real schema
		// may be what was found, and dropping it would take the genuine table.
		$findings = self::$tables['findings'];
		$has_visit = $wpdb->get_var(
			$wpdb->prepare(
				'SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
				 WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND COLUMN_NAME = %s',
				$wpdb->dbname,
				$findings,
				'visit_sequence'
			)
		);
		if ( ! (int) $has_visit ) {
			$wpdb->query( "ALTER TABLE {$findings} ADD COLUMN visit_sequence tinyint(3) UNSIGNED NOT NULL DEFAULT 1" );
		}
	}

	public static function tearDownAfterClass(): void {
		global $wpdb;
		foreach ( array_reverse( self::$created ) as $table ) {
			$wpdb->query( "DROP TABLE IF EXISTS {$table}" );
		}
		self::$created = array();
		parent::tearDownAfterClass();
	}

	public function setUp(): void {
		parent::setUp();
		global $wpdb;
		foreach ( self::$tables as $table ) {
			$wpdb->query( "DELETE FROM {$table}" );
		}
	}

	// ---- fixtures ----------------------------------------------------------

	private function create_plot( string $plot_number, ?string $deleted_at = null ): int {
		global $wpdb;
		$wpdb->insert(
			self::$tables['plots'],
			array(
				'plot_number' => $plot_number,
				'section'     => 'Burnside',
				'deleted_at'  => $deleted_at,
			)
		);
		return (int) $wpdb->insert_id;
	}

	private function create_finding( int $round_id, int $plot_id, string $status, ?string $category, int $requires_followup, ?string $voided_at = null, string $subdivision = '', int $visit = 1 ): void {
		global $wpdb;
		$wpdb->insert(
			self::$tables['findings'],
			array(
				'round_id'            => $round_id,
				'plot_id'             => $plot_id,
				// Part of UNIQUE KEY round_plot on the real table, so a caller
				// wanting two findings on one plot in one round varies this.
				'subdivision_identifier' => $subdivision,
				'visit_sequence'         => $visit,
				'compliance_status'   => $status,
				'compliance_category' => $category,
				// Supplied because the real schema has them NOT NULL; harmless
				// against the minimal fixture table.
				'findings_summary'    => 'Recorded during the primary round.',
				'inspector_user_ids'  => wp_json_encode( array( 1, 2 ) ),
				'requires_followup'   => $requires_followup,
				'voided_at'           => $voided_at,
			)
		);
	}

	/**
	 * @return array<int,string> Plot numbers returned for the round, in order.
	 */
	private function plot_numbers_for( object $round ): array {
		$m = new ReflectionMethod( Inspect_Ajax::class, 'fetch_plot_rows' );
		$m->setAccessible( true );
		$rows = $m->invoke( null, $round );

		return array_map( static fn( $row ) => (string) $row->plot_number, $rows );
	}

	/**
	 * A round row shaped as fetch_plot_rows() reads it: id + site_section, which
	 * is all a round is to the plot list now that one covers its whole section.
	 */
	private function primary_round( int $id = 100 ): object {
		return (object) array(
			'id'           => $id,
			'round_number' => '2026-06-Burnside',
			'site_section' => 'Burnside',
			'status'       => 'scheduled',
		);
	}

	// ---- tests -------------------------------------------------------------
	/**
	 * A primary round is unaffected: it lists the whole section, flagged or not.
	 */
	/**
	 * A re-inspection still shows what failed the first time.
	 *
	 * The plot list carries `previousCategory` so the inspector can tell which
	 * plots they are there to re-check. That used to come from the parent round;
	 * with follow-up rounds gone (#883) it comes from visit 1 of THIS round.
	 * Without it every plot in the section looks identical and the inspector is
	 * back to remembering or ringing someone, which is the problem #43 fixed.
	 */
	public function test_the_plot_list_carries_the_first_visits_category(): void {
		$plot = $this->create_plot( 'B9' );
		$this->create_finding( 100, $plot, 'non_compliant', 'category_3', 1, null, '', 1 );

		$m = new ReflectionMethod( Inspect_Ajax::class, 'fetch_plot_rows' );
		$m->setAccessible( true );
		$rows = $m->invoke( null, $this->primary_round( 100 ) );

		$this->assertSame(
			'category_3',
			$rows[0]->previous_category,
			"the first visit's category must reach the plot list"
		);
	}

	public function test_primary_round_lists_the_whole_section(): void {
		$a = $this->create_plot( 'B5' );
		$this->create_plot( 'B6' );
		$this->create_finding( 100, $a, 'non_compliant', 'category_3', 1 );

		$this->assertSame( array( 'B5', 'B6' ), $this->plot_numbers_for( $this->primary_round( 100 ) ) );
	}

	/**
	 * A plot holding more than one finding in a round is still ONE row.
	 *
	 * The finding joins in fetch_plot_rows() used to match on (plot_id,
	 * round_id), which is one-to-many as soon as a plot can be inspected twice
	 * in a round — and a one-to-many LEFT JOIN here does not add columns, it
	 * duplicates the PLOT. The inspector would open the round and see the same
	 * plot listed twice, which is an invitation to record it twice.
	 *
	 * The plot-centric redesign makes a second finding per plot the normal case
	 * (the re-inspection), so both joins now resolve to the latest finding via
	 * `id = (SELECT MAX(id) ...)`. `current_finding_id` must be that latest one,
	 * because the app uses it to decide whether to open a new record or edit the
	 * existing one.
	 *
	 * This is reachable TODAY, ahead of the schema change: UNIQUE KEY round_plot
	 * is (round_id, plot_id, subdivision_identifier), so a subdivided plot may
	 * already hold one finding per subdivision in a single round. The duplicate
	 * plot row is therefore a live defect for subdivided plots, not only a
	 * future risk — which is also why the fixture varies the subdivision rather
	 * than trying to insert a straight duplicate the constraint would reject.
	 */
	public function test_a_plot_with_two_findings_in_a_round_is_listed_once(): void {
		global $wpdb;

		$plot = $this->create_plot( 'B7' );
		$this->create_finding( 100, $plot, 'non_compliant', 'category_3', 1, null, '' );
		$this->create_finding( 100, $plot, 'compliant', 'category_1', 0, null, 'a' );

		$this->assertSame(
			2,
			(int) $wpdb->get_var(
				$wpdb->prepare(
					'SELECT COUNT(*) FROM ' . self::$tables['findings'] . ' WHERE round_id = %d AND plot_id = %d',
					100,
					$plot
				)
			),
			'Both findings must exist, or this test proves nothing'
		);

		$this->assertSame(
			array( 'B7' ),
			$this->plot_numbers_for( $this->primary_round( 100 ) ),
			'A plot with two findings in one round must appear once in the plot list'
		);

		$latest = (int) $wpdb->get_var(
			$wpdb->prepare(
				'SELECT MAX(id) FROM ' . self::$tables['findings'] . ' WHERE round_id = %d AND plot_id = %d',
				100,
				$plot
			)
		);

		$m = new ReflectionMethod( Inspect_Ajax::class, 'fetch_plot_rows' );
		$m->setAccessible( true );
		$rows = $m->invoke( null, $this->primary_round( 100 ) );

		$this->assertSame(
			$latest,
			(int) $rows[0]->current_finding_id,
			'The row must carry the LATEST finding, so the app edits the re-inspection not the original'
		);
	}

	// ---- plot order (#42) ---------------------------------------------------

	/**
	 * The live complaint. Ordering by `LENGTH(plot_number), plot_number` bucketed
	 * by digit count, so on the 2026 Vinery round the inspector got V1…V97 and
	 * THEN every subdivided plot, because "V3.1" is four characters and "V97" is
	 * three. A subdivided plot belongs at its own number.
	 */
	public function test_subdivided_plots_sort_at_their_number_not_after_the_section(): void {
		foreach ( array( 'B97', 'B3.2', 'B2', 'B3.1', 'B4', 'B95' ) as $number ) {
			$this->create_plot( $number );
		}

		$this->assertSame(
			array( 'B2', 'B3.1', 'B3.2', 'B4', 'B95', 'B97' ),
			$this->plot_numbers_for( $this->primary_round( 100 ) )
		);
	}

	/**
	 * The property the length-based sort DID get right, which must survive:
	 * numbers compare as numbers, so B9 precedes B10.
	 */
	public function test_numbers_still_sort_numerically(): void {
		foreach ( array( 'B10', 'B9', 'B100', 'B2' ) as $number ) {
			$this->create_plot( $number );
		}

		$this->assertSame(
			array( 'B2', 'B9', 'B10', 'B100' ),
			$this->plot_numbers_for( $this->primary_round( 100 ) )
		);
	}

	/**
	 * An undivided plot leads its own halves, because a missing subdivision
	 * counts as 0 rather than sorting as text.
	 */
	public function test_the_whole_plot_leads_its_subdivisions(): void {
		foreach ( array( 'B3.2', 'B3', 'B3.1' ) as $number ) {
			$this->create_plot( $number );
		}

		$this->assertSame(
			array( 'B3', 'B3.1', 'B3.2' ),
			$this->plot_numbers_for( $this->primary_round( 100 ) )
		);
	}
}
