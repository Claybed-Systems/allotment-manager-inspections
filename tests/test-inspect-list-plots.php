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
