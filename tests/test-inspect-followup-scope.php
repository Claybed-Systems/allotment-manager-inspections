<?php
/**
 * Which plots a follow-up round hands the inspector.
 *
 * A follow-up round re-inspects ONLY what the primary round flagged. The scope
 * predicate is `requires_followup = 1` on the parent's findings. Until #39 it
 * was `compliance_category IN ('category_2','category_3')`, which is the wrong
 * axis: category measures CULTIVATION (Category 1 is >= 75% cultivated) and is
 * independent of compliance status, so a plot failed for rubbish, derelict
 * structures, or a tenancy breach while well cultivated is Category 1 and was
 * silently missing from its own follow-up round. The live 2026 round contained
 * exactly one such plot.
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
	 * The production case. Non-compliant for a non-cultivation reason (rubbish,
	 * a tenancy breach), so the cultivation category is 1 — which the old
	 * category-based predicate read as "nothing to re-inspect".
	 */
	public function test_non_compliant_category_1_plot_is_listed(): void {
		$plot = $this->create_plot( 'B166' );
		$this->create_finding( 100, $plot, 'non_compliant', 'category_1', 1 );

		$this->assertSame( array( 'B166' ), $this->plot_numbers_for( $this->followup_round( 100 ) ) );
	}

	/**
	 * Since #43 the list carries the whole section, so "not re-inspected" is
	 * expressed as out-of-SCOPE rather than absent. The plot is still visible;
	 * it just is not work. These assert the scope predicate, which is the thing
	 * that decides what gets re-inspected, counted and recorded.
	 */
	public function test_compliant_plot_is_not_in_scope(): void {
		$plot = $this->create_plot( 'B167' );
		$this->create_finding( 100, $plot, 'compliant', 'category_1', 0 );

		$this->assertSame( array( 'B167' => false ), $this->scope_map_for( $this->followup_round( 100 ) ) );
	}

	/**
	 * Voided = the membership ended mid-round. Nothing live to re-inspect, and
	 * the plot must not be worked on a departed member's record.
	 */
	public function test_voided_finding_is_not_in_scope(): void {
		$plot = $this->create_plot( 'B168' );
		$this->create_finding( 100, $plot, 'non_compliant', 'category_3', 1, '2026-07-01 09:00:00' );

		$this->assertSame( array( 'B168' => false ), $this->scope_map_for( $this->followup_round( 100 ) ) );
	}

	public function test_deleted_plot_is_not_listed(): void {
		$plot = $this->create_plot( 'B169', '2026-07-01 09:00:00' );
		$this->create_finding( 100, $plot, 'non_compliant', 'category_3', 1 );

		$this->assertSame( array(), $this->plot_numbers_for( $this->followup_round( 100 ) ) );
	}

	/**
	 * Another round's flags do not put a plot in scope here. It is still listed
	 * — everything in the section is — but as context, not work.
	 */
	public function test_only_the_parent_rounds_flags_count(): void {
		$mine   = $this->create_plot( 'B170' );
		$others = $this->create_plot( 'B171' );
		$this->create_finding( 100, $mine, 'non_compliant', 'category_3', 1 );
		$this->create_finding( 999, $others, 'non_compliant', 'category_3', 1 );

		$this->assertSame(
			array( 'B170' => true, 'B171' => false ),
			$this->scope_map_for( $this->followup_round( 100 ) )
		);
	}

	/**
	 * Every flagged plot is in scope whatever its cultivation category, and the
	 * one that passed rides along out of scope, all in natural plot-number order.
	 */
	public function test_every_flagged_plot_is_in_scope_across_categories(): void {
		$c3 = $this->create_plot( 'B2' );
		$c2 = $this->create_plot( 'B10' );
		$c1 = $this->create_plot( 'B3' );
		$ok = $this->create_plot( 'B4' );
		$this->create_finding( 100, $c3, 'non_compliant', 'category_3', 1 );
		$this->create_finding( 100, $c2, 'non_compliant', 'category_2', 1 );
		$this->create_finding( 100, $c1, 'non_compliant', 'category_1', 1 );
		$this->create_finding( 100, $ok, 'compliant', 'category_1', 0 );

		$this->assertSame(
			array( 'B2' => true, 'B3' => true, 'B4' => false, 'B10' => true ),
			$this->scope_map_for( $this->followup_round( 100 ) ),
			'flagged plots in scope whatever the category; order stays natural'
		);
	}

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

	/**
	 * A follow-up now lists the WHOLE section, not only the flagged plots. The
	 * flagged-only list made the round hard to navigate: walking from V3 to V47
	 * past forty plots that were not on the list left the inspector with nothing
	 * to place themselves against.
	 */
	public function test_followup_lists_the_whole_section_with_scope_flagged(): void {
		$flagged = $this->create_plot( 'B1' );
		$this->create_plot( 'B2' );
		$this->create_plot( 'B3' );
		$this->create_finding( 100, $flagged, 'non_compliant', 'category_3', 1 );

		$this->assertSame(
			array( 'B1' => true, 'B2' => false, 'B3' => false ),
			$this->scope_map_for( $this->followup_round( 100 ) ),
			'every plot is listed; only the flagged one is in scope'
		);
	}

	/**
	 * A plot that PASSED the first round is present but out of scope — that is
	 * the whole point: it is context, not work.
	 */
	public function test_a_plot_that_passed_is_listed_but_out_of_scope(): void {
		$passed = $this->create_plot( 'B7' );
		$this->create_finding( 100, $passed, 'compliant', 'category_1', 0 );

		$this->assertSame( array( 'B7' => false ), $this->scope_map_for( $this->followup_round( 100 ) ) );
	}

	/**
	 * A voided finding does not put its plot in scope — the membership ended, so
	 * there is no live non-compliance to re-inspect. It still appears in the
	 * list, faded, like any other plot in the section.
	 */
	public function test_a_voided_finding_leaves_the_plot_listed_but_out_of_scope(): void {
		$plot = $this->create_plot( 'B8' );
		$this->create_finding( 100, $plot, 'non_compliant', 'category_3', 1, '2026-07-01 09:00:00' );

		$this->assertSame( array( 'B8' => false ), $this->scope_map_for( $this->followup_round( 100 ) ) );
	}

	/**
	 * A primary round has no out-of-scope plots: everything in the section is
	 * being inspected.
	 */
	public function test_every_plot_is_in_scope_on_a_primary_round(): void {
		$this->create_plot( 'B1' );
		$this->create_plot( 'B2' );

		$this->assertSame(
			array( 'B1' => true, 'B2' => true ),
			$this->scope_map_for( $this->primary_round( 100 ) )
		);
	}

	/**
	 * Section equality is enforced when a round is created, but a flagged plot
	 * must never fall out of its OWN follow-up if the data says otherwise —
	 * dropping a flagged plot is the bug #40 was about, and it must not return
	 * through the section filter.
	 */
	public function test_a_flagged_plot_in_another_section_is_still_listed(): void {
		global $wpdb;
		$wpdb->insert(
			self::$tables['plots'],
			array( 'plot_number' => 'V9', 'section' => 'Vinery', 'deleted_at' => null )
		);
		$stray = (int) $wpdb->insert_id;
		$this->create_finding( 100, $stray, 'non_compliant', 'category_3', 1 );

		$scope = $this->scope_map_for( $this->followup_round( 100 ) );

		$this->assertArrayHasKey( 'V9', $scope, 'a flagged plot stays in its own follow-up' );
		$this->assertTrue( $scope['V9'] );
	}

	/**
	 * A deleted plot is gone from the list whether flagged or not.
	 */
	public function test_deleted_plots_are_not_listed(): void {
		$this->create_plot( 'B4', '2026-07-01 09:00:00' );
		$this->create_plot( 'B5' );

		$this->assertSame( array( 'B5' => false ), $this->scope_map_for( $this->followup_round( 100 ) ) );
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

	/**
	 * The list renders an out-of-scope plot unclickable, but the app is an
	 * offline PWA: a page cached before #43, or a finding queued against a stale
	 * list, still posts. So scope is enforced on the server and the fade is only
	 * an affordance.
	 */
	public function test_a_plot_that_passed_cannot_be_recorded_on_a_followup(): void {
		$passed   = $this->create_plot( 'B20' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $passed, 'compliant', 'category_1', 0 );

		$this->assertFalse( $this->in_scope( $followup, $passed ) );
	}

	public function test_a_flagged_plot_can_be_recorded_on_a_followup(): void {
		$flagged  = $this->create_plot( 'B21' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $flagged, 'non_compliant', 'category_3', 1 );

		$this->assertTrue( $this->in_scope( $followup, $flagged ) );
	}

	/**
	 * A voided flag is not a live one, so the plot cannot be recorded against
	 * either — the same predicate the list and the denominator use.
	 */
	public function test_a_voided_flag_does_not_permit_recording(): void {
		$plot     = $this->create_plot( 'B22' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $plot, 'non_compliant', 'category_3', 1, '2026-07-01 09:00:00' );

		$this->assertFalse( $this->in_scope( $followup, $plot ) );
	}

	/**
	 * Everything in the section is recordable on a primary round — the guard
	 * must not leak into the round type it does not apply to.
	 */
	public function test_every_plot_is_recordable_on_a_primary_round(): void {
		$plot    = $this->create_plot( 'B23' );
		$primary = $this->insert_round( 'primary' );

		$this->assertTrue( $this->in_scope( $primary, $plot ) );
	}

	/**
	 * An unscoped follow-up has no in-scope plots at all. list_plots() already
	 * refuses to serve one (#42), so nothing can legitimately be recorded.
	 */
	public function test_nothing_is_recordable_on_a_parentless_followup(): void {
		$plot     = $this->create_plot( 'B24' );
		$followup = $this->insert_round( 'followup', null );

		$this->assertFalse( $this->in_scope( $followup, $plot ) );
	}

	/**
	 * A round that cannot be read is not a scope decision — fail open and let
	 * create_finding() reject the invalid round with a better message.
	 */
	public function test_an_unknown_round_is_left_to_the_model(): void {
		$plot = $this->create_plot( 'B25' );

		$this->assertTrue( $this->in_scope( 999999, $plot ) );
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

	/**
	 * The requirement: an inspector on a follow-up has to be able to verify that
	 * the required work was done, which means seeing what was wrong. The
	 * previous CATEGORY alone ("Cat 3") says how bad it was, not what to look at.
	 */
	public function test_the_followup_screen_carries_the_first_rounds_work_order(): void {
		global $wpdb;
		$plot     = $this->create_plot( 'B30' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $plot, 'non_compliant', 'category_3', 1 );
		$wpdb->update(
			self::$tables['findings'],
			array( 'has_rubbish' => 1, 'has_overgrown_weeds' => 1, 'findings_summary' => 'Bindweed across the western beds; clear the rubbish by the shed.' ),
			array( 'plot_id' => $plot, 'round_id' => $parent )
		);

		$prev = $this->previous_finding_for( $followup, $plot );

		$this->assertIsArray( $prev );
		$this->assertSame( 'category_3', $prev['category'] );
		$this->assertStringContainsString( 'Bindweed', (string) $prev['summary'] );
		$this->assertTrue( $prev['issues']['rubbish'], 'the ticked issues ARE the work order' );
		$this->assertTrue( $prev['issues']['overgrownWeeds'] );
		$this->assertFalse( $prev['issues']['derelictStructures'] );
	}

	/**
	 * A primary round has no previous result to show.
	 */
	public function test_a_primary_round_has_no_previous_finding(): void {
		$plot    = $this->create_plot( 'B31' );
		$primary = $this->insert_round( 'primary' );
		$this->create_finding( $primary, $plot, 'non_compliant', 'category_3', 1 );

		$this->assertNull( $this->previous_finding_for( $primary, $plot ) );
	}

	/**
	 * An out-of-scope plot opened on a follow-up still reports what the first
	 * round found — it passed, and saying so is the whole reason it is listed.
	 */
	public function test_a_plot_that_passed_still_reports_its_first_round_result(): void {
		$plot     = $this->create_plot( 'B32' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $plot, 'compliant', 'category_1', 0 );

		$prev = $this->previous_finding_for( $followup, $plot );

		$this->assertIsArray( $prev );
		$this->assertSame( 'compliant', $prev['status'] );
	}

	/**
	 * A plot the parent never recorded has nothing to show, and must not invent
	 * an empty work order.
	 */
	public function test_a_plot_the_parent_never_recorded_has_no_previous_finding(): void {
		$plot     = $this->create_plot( 'B33' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );

		$this->assertNull( $this->previous_finding_for( $followup, $plot ) );
	}

	/**
	 * A voided first-round finding is surfaced as voided rather than presented
	 * as a live work order — the membership ended, so the work is not owed.
	 */
	public function test_a_voided_first_round_finding_is_marked_voided(): void {
		$plot     = $this->create_plot( 'B34' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $plot, 'non_compliant', 'category_3', 1, '2026-07-01 09:00:00' );

		$prev = $this->previous_finding_for( $followup, $plot );

		$this->assertIsArray( $prev );
		$this->assertTrue( $prev['isVoided'] );
	}

	public function test_an_unscoped_followup_has_no_previous_finding(): void {
		$plot     = $this->create_plot( 'B35' );
		$followup = $this->insert_round( 'followup', null );

		$this->assertNull( $this->previous_finding_for( $followup, $plot ) );
	}

	/**
	 * The photographs are the part that actually settles it on site — a
	 * before-picture to hold the plot against.
	 */
	public function test_the_first_rounds_photographs_travel_with_it(): void {
		global $wpdb;
		$plot     = $this->create_plot( 'B36' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $plot, 'non_compliant', 'category_3', 1 );

		$finding_id = (int) $wpdb->get_var( $wpdb->prepare(
			"SELECT id FROM " . self::$tables['findings'] . " WHERE plot_id = %d AND round_id = %d",
			$plot,
			$parent
		) );
		$wpdb->insert( self::$tables['photos'], array(
			'finding_id'                 => $finding_id,
			'google_drive_url'           => 'https://drive.example/full.jpg',
			'google_drive_thumbnail_url' => 'https://drive.example/thumb.jpg',
			'photo_caption'              => 'Western beds',
			'photo_order'                => 0,
		) );

		$prev = $this->previous_finding_for( $followup, $plot );

		$this->assertCount( 1, $prev['photos'] );
		$this->assertSame( 'https://drive.example/thumb.jpg', $prev['photos'][0]['thumbnailUrl'] );
		$this->assertSame( 'Western beds', $prev['photos'][0]['caption'] );
	}

	/**
	 * A soft-deleted photo is not shown.
	 */
	public function test_a_deleted_photograph_is_not_returned(): void {
		global $wpdb;
		$plot     = $this->create_plot( 'B37' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $plot, 'non_compliant', 'category_3', 1 );

		$finding_id = (int) $wpdb->get_var( $wpdb->prepare(
			"SELECT id FROM " . self::$tables['findings'] . " WHERE plot_id = %d AND round_id = %d",
			$plot,
			$parent
		) );
		$wpdb->insert( self::$tables['photos'], array(
			'finding_id'       => $finding_id,
			'google_drive_url' => 'https://drive.example/gone.jpg',
			'deleted_at'       => '2026-07-01 09:00:00',
		) );

		$this->assertSame( array(), $this->previous_finding_for( $followup, $plot )['photos'] );
	}

	/**
	 * Every column previous_finding() reads must exist in BOTH environments —
	 * the real schema and the fixture tables CI builds against a bare
	 * WordPress. A column present in one and not the other is green here and red
	 * in CI, which is how this nearly shipped.
	 */
	public function test_the_previous_finding_query_leaves_no_db_error(): void {
		global $wpdb;
		$plot     = $this->create_plot( 'B38' );
		$parent   = $this->insert_round( 'primary', null, 100 );
		$followup = $this->insert_round( 'followup', $parent );
		$this->create_finding( $parent, $plot, 'non_compliant', 'category_3', 1 );

		$this->previous_finding_for( $followup, $plot );

		$this->assertSame( '', $wpdb->last_error, 'previous_finding hit a DB error: ' . $wpdb->last_error );
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

	/**
	 * A follow-up round's list is ordered by the same rule, so an inspector sees
	 * one ordering whichever visit they are on.
	 */
	public function test_the_followup_list_uses_the_same_order(): void {
		foreach ( array( 'B97', 'B3.2', 'B3.1' ) as $number ) {
			$this->create_finding( 100, $this->create_plot( $number ), 'non_compliant', 'category_3', 1 );
		}

		$this->assertSame(
			array( 'B3.1', 'B3.2', 'B97' ),
			$this->plot_numbers_for( $this->followup_round( 100 ) )
		);
	}

	// ---- the unscoped-follow-up guard (#40) --------------------------------

	private function is_unscoped( object $round ): bool {
		$m = new ReflectionMethod( Inspect_Ajax::class, 'is_unscoped_followup' );
		$m->setAccessible( true );
		return (bool) $m->invoke( null, $round );
	}

	/**
	 * The live failure. A follow-up with no parent has no scope to resolve, and
	 * the query branch would fall through to "every plot in the section" — which
	 * is what both 2026 follow-up rounds did for a full round before anyone
	 * noticed, because a too-long list looks like a busy round.
	 */
	public function test_followup_without_a_parent_is_refused(): void {
		$this->assertTrue( $this->is_unscoped( $this->followup_round( 0 ) ) );
	}

	public function test_followup_with_a_null_parent_is_refused(): void {
		$round = $this->followup_round( 0 );
		$round->parent_round_id = null;

		$this->assertTrue( $this->is_unscoped( $round ) );
	}

	public function test_properly_scoped_followup_is_allowed(): void {
		$this->assertFalse( $this->is_unscoped( $this->followup_round( 100 ) ) );
	}

	/**
	 * A primary round legitimately has no parent, so the guard must not catch it.
	 */
	public function test_primary_round_is_not_treated_as_unscoped(): void {
		$this->assertFalse( $this->is_unscoped( $this->primary_round( 100 ) ) );
	}
}
