<?php
/**
 * Front-end route handler for /inspect/...
 *
 * Adds a rewrite rule that captures any URL under /inspect/ and sets the
 * `am_inspect` query var. On template_redirect, if the var is present, we
 * gate by capability and render the SPA shell.
 *
 * @package AllotmentManagerInspections
 */

namespace AllotmentManagerInspections;

defined( 'ABSPATH' ) || exit;

/**
 * Route class — registers rewrite rule + query var + template handler.
 */
final class Route {

	/**
	 * Register hooks.
	 *
	 * @return void
	 */
	public static function register(): void {
		\add_action( 'init', [ self::class, 'add_rewrite' ] );
		\add_filter( 'query_vars', [ self::class, 'add_query_var' ] );
		\add_action( 'template_redirect', [ self::class, 'maybe_render' ] );
	}

	/**
	 * Add the /inspect/ rewrite rule. Captures both /inspect and /inspect/anything.
	 *
	 * @return void
	 */
	public static function add_rewrite(): void {
		\add_rewrite_rule(
			'^inspect(/.*)?/?$',
			'index.php?am_inspect=1',
			'top'
		);
	}

	/**
	 * Register the custom query variable.
	 *
	 * @param string[] $vars
	 * @return string[]
	 */
	public static function add_query_var( array $vars ): array {
		$vars[] = 'am_inspect';
		return $vars;
	}

	/**
	 * If our query var is set, intercept the template and either redirect
	 * (unauthenticated/unauthorised) or render our shell and exit.
	 *
	 * @return void
	 */
	public static function maybe_render(): void {
		if ( ! \get_query_var( 'am_inspect' ) ) {
			return;
		}

		// Block 404 status that WP may have set when matching this URL.
		\status_header( 200 );
		global $wp_query;
		if ( $wp_query ) {
			$wp_query->is_404 = false;
		}

		// Auth gate.
		if ( ! \is_user_logged_in() ) {
			\wp_safe_redirect( \wp_login_url( \home_url( '/inspect/' ) ) );
			exit;
		}
		if ( ! \current_user_can( AMI_CAPABILITY ) ) {
			\wp_die(
				\esc_html__( 'You do not have permission to use the field inspector.', 'allotment-manager-inspections' ),
				\esc_html__( 'Inspector access required', 'allotment-manager-inspections' ),
				[ 'response' => 403 ]
			);
		}

		// Enqueue assets. Doing this from template_redirect is unconventional,
		// but works because we control the entire HTML output below.
		self::enqueue_assets();

		// Render the SPA shell. The included file may use `$data` (from
		// Plugin::script_data()) and outputs the full HTML response.
		$data = Plugin::script_data();
		include AMI_PLUGIN_DIR . 'public/views/shell.php';
		exit;
	}

	/**
	 * Enqueue CSS + JS module entry. Service worker is registered from JS
	 * (not enqueued by WP since it must live at a stable URL).
	 *
	 * @return void
	 */
	private static function enqueue_assets(): void {
		\wp_enqueue_style(
			'ami-inspect',
			AMI_PLUGIN_URL . 'public/css/inspect.css',
			[],
			AMI_VERSION
		);
	}
}
