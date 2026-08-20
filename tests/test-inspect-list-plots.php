<?php
/**
 * Unit tests for the am_inspect_list_plots Map-view additions (v1.1.0).
 *
 * Pins the contract without touching the DB or the main-plugin schema (whose
 * migrations don't run in this repo's test env): each plot row maps to a shape
 * carrying lat/lng (the wp_am_map_objects centroid, or null when unpositioned),
 * and the tile config is well-formed.
 *
 * The two pieces are pure helpers (Inspect_Ajax::format_plot_row / tile_config),
 * exercised here via reflection so the handler's public surface stays small.
 *
 * @package AllotmentManagerInspections
 */

use AllotmentManagerInspections\Inspect_Ajax;

class Test_Inspect_List_Plots extends WP_UnitTestCase {

	private function call_format( object $row ): array {
		$m = new ReflectionMethod( Inspect_Ajax::class, 'format_plot_row' );
		$m->setAccessible( true );
		return $m->invoke( null, $row );
	}

	private function call_tile_config(): array {
		$m = new ReflectionMethod( Inspect_Ajax::class, 'tile_config' );
		$m->setAccessible( true );
		return $m->invoke( null );
	}

	private function row( array $overrides = array() ): object {
		return (object) array_merge(
			array(
				'id'                 => 7,
				'plot_number'        => 'B1',
				'section'            => 'Burnside',
				'current_member_id'  => 42,
				'first_name'         => 'Alice',
				'last_name'          => 'Green',
				'latitude'           => '51.50000000',
				'longitude'          => '-0.12000000',
				'width'              => '70',
				'height'             => '20',
				'rotation_angle'     => '281.40',
				'current_finding_id' => null,
				'current_category'   => null,
				'current_status'     => null,
				'previous_category'  => null,
			),
			$overrides
		);
	}

	public function test_positioned_plot_carries_float_geometry(): void {
		$out = $this->call_format( $this->row() );

		$this->assertArrayHasKey( 'lat', $out );
		$this->assertArrayHasKey( 'lng', $out );
		$this->assertIsFloat( $out['lat'] );
		$this->assertIsFloat( $out['lng'] );
		$this->assertEqualsWithDelta( 51.5, $out['lat'], 0.0001 );
		$this->assertEqualsWithDelta( -0.12, $out['lng'], 0.0001 );

		// Footprint geometry (drives the map's rotated-rectangle rendering).
		$this->assertSame( 70, $out['width'] );
		$this->assertSame( 20, $out['height'] );
		$this->assertIsFloat( $out['rotation'] );
		$this->assertEqualsWithDelta( 281.4, $out['rotation'], 0.01 );

		// Existing list fields are preserved.
		$this->assertSame( 7, $out['id'] );
		$this->assertSame( 'B1', $out['plotNumber'] );
		$this->assertSame( 'Alice Green', $out['tenantName'] );
	}

	public function test_unpositioned_plot_has_null_geometry(): void {
		$out = $this->call_format(
			$this->row(
				array(
					'latitude'       => null,
					'longitude'      => null,
					'width'          => null,
					'height'         => null,
					'rotation_angle' => null,
				)
			)
		);

		$this->assertNull( $out['lat'] );
		$this->assertNull( $out['lng'] );
		$this->assertNull( $out['width'] );
		$this->assertNull( $out['height'] );
		$this->assertNull( $out['rotation'] );
		// Still a fully-formed plot, just unplaced.
		$this->assertSame( 'B1', $out['plotNumber'] );
	}

	public function test_vacant_plot_has_null_tenant(): void {
		$out = $this->call_format(
			$this->row( array( 'current_member_id' => null, 'first_name' => null, 'last_name' => null ) )
		);

		$this->assertNull( $out['tenantName'] );
		$this->assertNull( $out['memberId'] );
	}

	public function test_resolves_holder_from_active_assignment_when_current_member_null(): void {
		// current_member_id left NULL (the orphaned-allocated gap) but the active
		// assignment resolves the holder — the plot must still show by name and
		// carry the resolved member id (so save_finding can fire the exemption).
		$out = $this->call_format(
			$this->row(
				array(
					'current_member_id'     => null,
					'effective_member_id'   => 99,
					'first_name'            => 'Bob',
					'last_name'             => 'New',
					'assignment_start_date' => ( (int) gmdate( 'Y' ) - 5 ) . '-04-01',
				)
			)
		);

		$this->assertSame( 99, $out['memberId'] );
		$this->assertSame( 'Bob New', $out['tenantName'] );
		$this->assertFalse( $out['isVacant'] );
		$this->assertFalse( $out['isNewTenant'] );
	}

	public function test_new_tenant_flagged_when_started_after_march_cutoff(): void {
		$out = $this->call_format(
			$this->row(
				array(
					'current_member_id'     => 99,
					'effective_member_id'   => 99,
					'first_name'            => 'Casey',
					'last_name'             => 'Fresh',
					'assignment_start_date' => gmdate( 'Y' ) . '-06-01', // after 1 March of this year
				)
			)
		);

		$this->assertTrue( $out['isNewTenant'] );
		$this->assertFalse( $out['isVacant'] );
		$this->assertSame( gmdate( 'Y' ) . '-06-01', $out['tenantStartDate'] );
	}

	public function test_established_tenant_not_flagged_new(): void {
		$out = $this->call_format(
			$this->row(
				array(
					'current_member_id'     => 99,
					'effective_member_id'   => 99,
					'assignment_start_date' => ( (int) gmdate( 'Y' ) - 3 ) . '-04-01',
				)
			)
		);

		$this->assertFalse( $out['isNewTenant'] );
	}

	public function test_vacant_plot_flags(): void {
		$out = $this->call_format(
			$this->row(
				array(
					'current_member_id'   => null,
					'effective_member_id' => null,
					'first_name'          => null,
					'last_name'           => null,
				)
			)
		);

		$this->assertTrue( $out['isVacant'] );
		$this->assertFalse( $out['isNewTenant'] );
		$this->assertNull( $out['tenantStartDate'] );
		$this->assertNull( $out['memberId'] );
	}

	public function test_own_plot_flagged_when_holder_is_current_user(): void {
		// The holder's linked WP user IS the logged-in inspector → their own plot.
		// The finding editor blocks recording it (the server's self-inspection
		// guard would reject the finding and it would stick in the sync queue).
		$uid = self::factory()->user->create();
		wp_set_current_user( $uid );

		$out = $this->call_format(
			$this->row(
				array(
					'current_member_id'   => 42,
					'effective_member_id' => 42,
					'holder_user_id'      => $uid,
				)
			)
		);

		$this->assertTrue( $out['isOwnPlot'] );
		$this->assertFalse( $out['isVacant'] );
		wp_set_current_user( 0 );
	}

	public function test_other_members_plot_not_flagged_own(): void {
		$me    = self::factory()->user->create();
		$other = self::factory()->user->create();
		wp_set_current_user( $me );

		$out = $this->call_format(
			$this->row(
				array(
					'effective_member_id' => 42,
					'holder_user_id'      => $other,
				)
			)
		);

		$this->assertFalse( $out['isOwnPlot'] );
		wp_set_current_user( 0 );
	}

	public function test_vacant_plot_not_flagged_own(): void {
		$me = self::factory()->user->create();
		wp_set_current_user( $me );

		// No holder_user_id (vacant / no linked WP account) must never be "own".
		$out = $this->call_format(
			$this->row(
				array(
					'current_member_id'   => null,
					'effective_member_id' => null,
					'first_name'          => null,
					'last_name'           => null,
				)
			)
		);

		$this->assertFalse( $out['isOwnPlot'] );
		wp_set_current_user( 0 );
	}

	public function test_own_plot_never_true_for_logged_out_context(): void {
		// current_user_id() === 0 must not collide with an absent/0 holder id.
		wp_set_current_user( 0 );

		$out = $this->call_format( $this->row( array( 'holder_user_id' => 7 ) ) );

		$this->assertFalse( $out['isOwnPlot'] );
	}

	/**
	 * The plot list must carry compliance_status, not the category alone.
	 *
	 * The two axes are independent: the category measures CULTIVATION and is
	 * NULL on an exempt or under-review finding, so a list that reads only the
	 * category cannot tell "not inspected" from "inspected and exempted", and
	 * cannot answer "show me the non-compliant plots" — the question the
	 * committee's own round screen is built around.
	 */
	public function test_plot_carries_its_compliance_status(): void {
		$out = $this->call_format(
			$this->row(
				array(
					'current_finding_id' => 501,
					'current_category'   => 'category_3',
					'current_status'     => 'non_compliant',
				)
			)
		);

		$this->assertSame( 'non_compliant', $out['currentStatus'] );
		$this->assertSame( 'category_3', $out['currentCategory'] );
		$this->assertSame( 501, $out['currentFindingId'] );
	}

	/**
	 * An exempt finding has a status but NO cultivation category.
	 *
	 * This is the row that used to render as "Not inspected" on the field app
	 * while the website showed it as Exempt.
	 */
	public function test_exempt_finding_has_status_without_category(): void {
		$out = $this->call_format(
			$this->row(
				array(
					'current_finding_id' => 502,
					'current_category'   => null,
					'current_status'     => 'exempt',
				)
			)
		);

		$this->assertSame( 'exempt', $out['currentStatus'] );
		$this->assertNull( $out['currentCategory'] );
	}

	/**
	 * A plot with no finding in this round carries no status at all.
	 */
	public function test_uninspected_plot_has_null_status(): void {
		$out = $this->call_format( $this->row() );

		$this->assertNull( $out['currentStatus'] );
		$this->assertNull( $out['currentFindingId'] );
	}

	/**
	 * A row shaped before the column existed must not fatal.
	 *
	 * format_plot_row() is fed straight from a wpdb result, and the app also
	 * replays cached payloads; an absent property has to read as "unknown",
	 * not as an undefined-property error.
	 */
	public function test_row_without_the_status_column_degrades_to_null(): void {
		$row = $this->row();
		unset( $row->current_status );

		$out = $this->call_format( $row );

		$this->assertNull( $out['currentStatus'] );
	}

	public function test_tile_config_is_well_formed(): void {
		$tile = $this->call_tile_config();

		$this->assertArrayHasKey( 'url', $tile );
		$this->assertArrayHasKey( 'attribution', $tile );
		$this->assertArrayHasKey( 'maxZoom', $tile );
		$this->assertStringContainsString( '{z}', $tile['url'] );
	}

	public function test_tile_config_honours_am_map_tile_layer_filter(): void {
		$custom = array(
			'url'         => 'https://tiles.example/{z}/{x}/{y}.png',
			'attribution' => 'Example',
			'maxZoom'     => 20,
			'subdomains'  => 'abc',
		);
		$cb = static fn() => $custom;
		add_filter( 'am_map_tile_layer', $cb );

		$tile = $this->call_tile_config();
		remove_filter( 'am_map_tile_layer', $cb );

		$this->assertSame( 'https://tiles.example/{z}/{x}/{y}.png', $tile['url'] );
		$this->assertSame( 20, $tile['maxZoom'] );
	}
}
