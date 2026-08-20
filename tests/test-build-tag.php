<?php
/**
 * The on-screen build tag must be the plugin version.
 *
 * The header renders `v` . sync.js's BUILD constant, and the Sync-queue screen
 * repeats it. Its whole job is to answer "is this phone running the latest
 * code?" — so a wrong value is worse than no value at all: it reports a build
 * the device is not running, and a genuinely stale phone becomes
 * indistinguishable from a current one.
 *
 * It is hand-maintained on purpose. It cannot be read from window.amiData: the
 * shell is fetched network-first, so a server-sourced tag would report the
 * fresh version even while the device ran a cached module — exactly the case
 * the tag exists to catch. Baked in, it can only be kept honest by a test.
 *
 * It drifted once already: it stayed at 1.4.4 from 5 July 2026 while
 * AMI_VERSION went on to 1.5.0, so every release after that displayed July's
 * number. Before that they had tracked in lockstep through eleven releases.
 * The plugin header and AMI_VERSION had drifted the same way before (1.4.3 vs
 * 1.4.4), which is why the header carries a warning of its own — this is the
 * third value in that set, and the only one nothing was watching.
 *
 * @package AllotmentManagerInspections
 */

class Test_Build_Tag extends WP_UnitTestCase {

	/**
	 * The BUILD constant as sync.js actually declares it.
	 *
	 * Read from source rather than executed: it is an ES module, and there is
	 * no JS runtime in this suite.
	 *
	 * @return string
	 */
	private function build_tag(): string {
		$path = AMI_PLUGIN_DIR . 'public/js/services/sync.js';
		$this->assertFileExists( $path, 'sync.js is where the build tag lives' );

		$matched = preg_match(
			'/^export const BUILD = \'([^\']+)\';$/m',
			(string) file_get_contents( $path ),
			$m
		);

		$this->assertSame(
			1,
			$matched,
			'sync.js must declare BUILD as a single-quoted string literal on one line — '
				. 'if that declaration is reshaped, reshape this matcher with it rather than deleting the test'
		);

		return $m[1];
	}

	/**
	 * The three version strings a release has to move together.
	 */
	public function test_build_tag_matches_the_plugin_version(): void {
		$this->assertSame(
			AMI_VERSION,
			$this->build_tag(),
			'the build tag shown in the app header must be the version actually shipped — bump BOTH or neither'
		);
	}

	/**
	 * AMI_VERSION busts the asset URLs; the `Version:` header is what the
	 * Plugins screen shows. These two have drifted before.
	 */
	public function test_plugin_header_matches_ami_version(): void {
		$header = (string) file_get_contents( AMI_PLUGIN_DIR . 'allotment-manager-inspections.php' );

		$this->assertSame(
			1,
			preg_match( '/^ \* Version: (.+)$/m', $header, $m ),
			'the plugin file must carry a Version: header'
		);
		$this->assertSame(
			AMI_VERSION,
			trim( $m[1] ),
			'the Version: header and AMI_VERSION must agree'
		);
	}

	/**
	 * The readme's Stable tag is the third. It had drifted to 1.3.0 while the
	 * plugin shipped 1.5.0.
	 */
	public function test_readme_stable_tag_matches_ami_version(): void {
		$readme = (string) file_get_contents( AMI_PLUGIN_DIR . 'readme.txt' );

		$this->assertSame(
			1,
			preg_match( '/^Stable tag: (.+)$/m', $readme, $m ),
			'readme.txt must carry a Stable tag'
		);
		$this->assertSame(
			AMI_VERSION,
			trim( $m[1] ),
			'the readme Stable tag and AMI_VERSION must agree'
		);
	}
}
