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
			'findings'    => "(
				id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
				round_id bigint(20) UNSIGNED NOT NULL,
				plot_id bigint(20) UNSIGNED NOT NULL,
				compliance_status varchar(30) NOT NULL DEFAULT 'compliant',
				compliance_category varchar(30) DEFAULT NULL,
				findings_summary text,
				inspector_user_ids text,
				requires_followup tinyint(1) NOT NULL DEFAULT 0,
				voided_at datetime DEFAULT NULL,
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

	private function create_finding( int $round_id, int $plot_id, string $status, ?string $category, int $requires_followup, ?string $voided_at = null ): void {
		global $wpdb;
		$wpdb->insert(
			self::$tables['findings'],
			array(
				'round_id'            => $round_id,
				'plot_id'             => $plot_id,
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

	public function test_compliant_plot_is_not_listed(): void {
		$plot = $this->create_plot( 'B167' );
		$this->create_finding( 100, $plot, 'compliant', 'category_1', 0 );

		$this->assertSame( array(), $this->plot_numbers_for( $this->followup_round( 100 ) ) );
	}

	/**
	 * Voided = the membership ended mid-round. Nothing live to re-inspect, and
	 * the plot must not reappear on a departed member's record.
	 */
	public function test_voided_finding_is_not_listed(): void {
		$plot = $this->create_plot( 'B168' );
		$this->create_finding( 100, $plot, 'non_compliant', 'category_3', 1, '2026-07-01 09:00:00' );

		$this->assertSame( array(), $this->plot_numbers_for( $this->followup_round( 100 ) ) );
	}

	public function test_deleted_plot_is_not_listed(): void {
		$plot = $this->create_plot( 'B169', '2026-07-01 09:00:00' );
		$this->create_finding( 100, $plot, 'non_compliant', 'category_3', 1 );

		$this->assertSame( array(), $this->plot_numbers_for( $this->followup_round( 100 ) ) );
	}

	public function test_only_the_parent_rounds_flags_count(): void {
		$mine   = $this->create_plot( 'B170' );
		$others = $this->create_plot( 'B171' );
		$this->create_finding( 100, $mine, 'non_compliant', 'category_3', 1 );
		$this->create_finding( 999, $others, 'non_compliant', 'category_3', 1 );

		$this->assertSame( array( 'B170' ), $this->plot_numbers_for( $this->followup_round( 100 ) ) );
	}

	/**
	 * Every flagged plot, whatever its cultivation category, in natural
	 * plot-number order.
	 */
	public function test_lists_every_flagged_plot_across_categories(): void {
		$c3 = $this->create_plot( 'B2' );
		$c2 = $this->create_plot( 'B10' );
		$c1 = $this->create_plot( 'B3' );
		$ok = $this->create_plot( 'B4' );
		$this->create_finding( 100, $c3, 'non_compliant', 'category_3', 1 );
		$this->create_finding( 100, $c2, 'non_compliant', 'category_2', 1 );
		$this->create_finding( 100, $c1, 'non_compliant', 'category_1', 1 );
		$this->create_finding( 100, $ok, 'compliant', 'category_1', 0 );

		$this->assertSame(
			array( 'B2', 'B3', 'B10' ),
			$this->plot_numbers_for( $this->followup_round( 100 ) ),
			'flagged plots only, shortest-first natural order'
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
