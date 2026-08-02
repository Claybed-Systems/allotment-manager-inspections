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
			'rounds'      => $wpdb->prefix . 'am_inspection_rounds',
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
			// Only what plot_is_in_scope() reads, plus round_number. The list-scope
			// tests pass round rows in by hand; the save-guard has to look one up
			// for itself.
			//
			// round_number is here because the REAL table carries it NOT NULL with
			// a UNIQUE key, and wpdb strips STRICT_TRANS_TABLES — so an insert that
			// omits it silently writes '' and the SECOND fixture round collides on
			// the unique index rather than erroring. The failure then looks like a
			// scope bug (round not found, guard fails open) rather than a fixture
			// one, which is exactly how it presented.
			'rounds'      => "(
				id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				round_number varchar(50) NOT NULL DEFAULT '',
				inspection_type varchar(20) NOT NULL DEFAULT 'primary',
				parent_round_id bigint(20) UNSIGNED DEFAULT NULL,
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

	private function create_finding( int $round_id, int $plot_id, string $status, ?string $category, int $requires_followup, ?string $voided_at = null, string $subdivision = '' ): void {
		global $wpdb;
		$wpdb->insert(
			self::$tables['findings'],
			array(
				'round_id'            => $round_id,
				'plot_id'             => $plot_id,
				// Part of UNIQUE KEY round_plot on the real table, so a caller
				// wanting two findings on one plot in one round varies this.
				'subdivision_identifier' => $subdivision,
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

	private function followup_round( int $parent_round_id, int $id = 200 ): object {
		return (object) array(
			'id'              => $id,
			'round_number'    => '2026-08-Burnside-Followup',
			'site_section'    => 'Burnside',
			'inspection_type' => 'followup',
			'parent_round_id' => $parent_round_id,
			'status'          => 'scheduled',
		);
	}

	private function primary_round( int $id = 100 ): object {
		return (object) array(
			'id'              => $id,
			'round_number'    => '2026-06-Burnside-Primary',
			'site_section'    => 'Burnside',
			'inspection_type' => 'primary',
			'parent_round_id' => null,
			'status'          => 'scheduled',
		);
	}

	// ---- tests -------------------------------------------------------------
	/**
	 * A primary round is unaffected: it lists the whole section, flagged or not.
	 */
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

	// ---- the whole section, with scope flagged (#43) ------------------------

	/**
	 * @return array<string,bool> plot_number => inScope, in list order.
	 */
	private function scope_map_for( object $round ): array {
		$m = new ReflectionMethod( Inspect_Ajax::class, 'fetch_plot_rows' );
		$m->setAccessible( true );
		$format = new ReflectionMethod( Inspect_Ajax::class, 'format_plot_row' );
		$format->setAccessible( true );

		$out = array();
		foreach ( $m->invoke( null, $round ) as $row ) {
			$formatted = $format->invoke( null, $row );
			$out[ (string) $formatted['plotNumber'] ] = $formatted['inScope'];
		}
		return $out;
	}

	// ---- the save guard (#43) -----------------------------------------------

	/**
	 * @param string   $type      'primary' or 'followup'.
	 * @param int|null $parent_id Parent round for a follow-up.
	 * @return int Round id.
	 */
	private int $round_seq = 0;

	private function insert_round( string $type, ?int $parent_id = null, int $id = 0 ): int {
		global $wpdb;
		$data = array(
			// Unique per fixture round: the real table's round_number is NOT NULL
			// with a UNIQUE key. See the DDL note.
			'round_number'    => 'FIXTURE-' . $type . '-' . ( ++$this->round_seq ),
			'inspection_type' => $type,
			'parent_round_id' => $parent_id,
		);
		if ( $id > 0 ) {
			$data['id'] = $id;
		}
		$wpdb->insert( self::$tables['rounds'], $data );
		$this->assertSame( '', $wpdb->last_error, 'round fixture insert: ' . $wpdb->last_error );

		return $id > 0 ? $id : (int) $wpdb->insert_id;
	}

	private function in_scope( int $round_id, int $plot_id ): bool {
		$m = new ReflectionMethod( Inspect_Ajax::class, 'plot_is_in_scope' );
		$m->setAccessible( true );
		return (bool) $m->invoke( null, $round_id, $plot_id );
	}
	// ---- the first round's result, on the follow-up screen (#43) ------------

	/**
	 * @return array<string,mixed>|null
	 */
	private function previous_finding_for( int $round_id, int $plot_id ): ?array {
		$m = new ReflectionMethod( Inspect_Ajax::class, 'previous_finding' );
		$m->setAccessible( true );
		return $m->invoke( null, $round_id, $plot_id );
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

	// ---- the unscoped-follow-up guard (#40) --------------------------------

	private function is_unscoped( object $round ): bool {
		$m = new ReflectionMethod( Inspect_Ajax::class, 'is_unscoped_followup' );
		$m->setAccessible( true );
		return (bool) $m->invoke( null, $round );
	}
}
