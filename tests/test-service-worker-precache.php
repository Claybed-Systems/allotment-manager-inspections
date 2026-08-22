<?php
/**
 * Every shipped JS module must be pre-cached by the service worker.
 *
 * The PWA is the point of this plugin: an inspector walks a site with no
 * signal, and the app has to boot and run from the cache. A module that is not
 * in PRECACHE_URLS still works in the office, where the network fills the gap,
 * and fails in the field — which is the one place it matters, and the one place
 * nobody is watching a console.
 *
 * It is a list maintained by hand, so it can only be kept honest by a test.
 * `js/services/plot-search.js` was the sixteenth entry; adding a module and
 * forgetting the list is a one-line omission with no local symptom at all.
 *
 * VERSION is checked with it: the caches are keyed on it, so shipping new bytes
 * without bumping it leaves already-installed phones serving the old shell.
 *
 * @package AllotmentManagerInspections
 */

class Test_Service_Worker_Precache extends WP_UnitTestCase {

	/**
	 * The service worker's source.
	 *
	 * @return string
	 */
	private function source(): string {
		$path = AMI_PLUGIN_DIR . 'public/service-worker.js';
		$this->assertFileExists( $path, 'the service worker is what makes the app work offline' );

		return (string) file_get_contents( $path );
	}

	/**
	 * Every `public/js/**\/*.js` file, as a plugin-relative path.
	 *
	 * @return string[]
	 */
	private function shipped_modules(): array {
		$base = AMI_PLUGIN_DIR . 'public/js';
		$found = array();

		$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $base, FilesystemIterator::SKIP_DOTS ) );
		foreach ( $it as $file ) {
			if ( 'js' !== strtolower( $file->getExtension() ) ) {
				continue;
			}
			$found[] = 'js/' . str_replace( '\\', '/', substr( $file->getPathname(), strlen( $base ) + 1 ) );
		}

		sort( $found );

		return $found;
	}

	/**
	 * Nothing shipped may be missing from the pre-cache list.
	 */
	public function test_every_js_module_is_precached(): void {
		$source  = $this->source();
		$modules = $this->shipped_modules();

		$this->assertNotEmpty( $modules, 'public/js should hold the app modules' );

		$missing = array();
		foreach ( $modules as $module ) {
			// Entries are template literals: `${PLUGIN_BASE}js/services/api.js`.
			if ( false === strpos( $source, '${PLUGIN_BASE}' . $module . '`' ) ) {
				$missing[] = $module;
			}
		}

		$this->assertSame(
			array(),
			$missing,
			"These modules ship but are not pre-cached, so the app breaks offline once it needs them:\n"
				. implode( "\n", $missing )
				. "\nAdd them to PRECACHE_URLS in public/service-worker.js and bump VERSION."
		);
	}

	/**
	 * The service worker is not itself a module and must not be pre-cached —
	 * the browser fetches it on its own terms, and caching it can pin a device
	 * to the worker that is doing the pinning.
	 */
	public function test_the_worker_does_not_precache_itself(): void {
		$this->assertStringNotContainsString(
			'service-worker.js`',
			$this->source(),
			'the service worker must not pre-cache itself'
		);
	}

	/**
	 * VERSION must be a bumpable `vN`, since every cache name is built from it.
	 */
	public function test_version_is_a_bumpable_tag(): void {
		$matched = preg_match( "/^const VERSION = '(v\d+)';$/m", $this->source(), $m );

		$this->assertSame(
			1,
			$matched,
			'VERSION must stay a single-quoted vN literal on one line — the shell, runtime and tile '
				. 'caches are all keyed on it, so if that declaration is reshaped, reshape this matcher '
				. 'with it rather than deleting the test'
		);
	}
}
