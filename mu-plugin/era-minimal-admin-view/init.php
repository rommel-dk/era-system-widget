<?php

class Era_Minimal_Admin_View {

	private string $toggle_url = 'era_toggle_admin';

	function __construct() {
		add_action( 'plugins_loaded', [$this, 'load_textdomain'], 0 );
		add_action( 'admin_bar_menu', [ $this, 'render_toggle_button' ], 60 );
		add_action( 'wp_before_admin_bar_render', [ $this, 'clean_admin_bar_menu' ], 99 );
		add_action( 'init', [ $this, 'toggle_state' ] );
		add_action( 'admin_menu', [ $this, 'admin_menu' ], 100 );
		add_filter( 'woocommerce_admin_features', [ $this, 'woocommerce_admin_features' ], 20 );

		// Add our dashboard widget early, then remove other stuff later (99).
		add_action( 'wp_dashboard_setup', [ $this, 'add_era_system_status_widget' ], 5 );
		add_action( 'wp_dashboard_setup', [ $this, 'wp_dashboard_setup' ], 99 );

		add_action( 'admin_head', [ $this, 'admin_head' ] );
	}

	/**
	 * Load plugin text domain.
	 */
	public function load_textdomain(): void {
		load_muplugin_textdomain( 'era-minimal-admin-view', 'era-minimal-admin-view/languages' );
	}

	/**
	 * ---------
	 * ERA System Status Dashboard Widget
	 * ---------
	 */
	private function normalize_host( string $host ): string {
		$h = strtolower( trim( $host ) );
		if ( str_starts_with( $h, 'www.' ) ) {
			$h = substr( $h, 4 );
		}
		// remove port if any
		$h = preg_replace( '/:\d+$/', '', $h );
		return $h;
	}

	private function get_site_domain_for_widget(): string {
		$host = (string) wp_parse_url( home_url( '/' ), PHP_URL_HOST );

		if ( empty( $host ) && ! empty( $_SERVER['HTTP_HOST'] ) ) {
			$host = (string) $_SERVER['HTTP_HOST'];
		}

		$host = $this->normalize_host( $host );

		/**
		 * Filter to override detected domain (e.g. if you want to force prod domain from staging).
		 */
		$host = (string) apply_filters( 'era_system_widget_domain', $host );

		return $host;
	}

	private function get_widget_src_url(): string {
		$domain = $this->get_site_domain_for_widget();

		// Default GitHub Pages widget URL (your repo)
		$base = 'https://rommel-dk.github.io/era-system-widget/';

		/**
		 * Filter to override widget base URL (if you move hosting later).
		 */
		$base = (string) apply_filters( 'era_system_widget_base_url', $base );

		$src = add_query_arg(
			[ 'domain' => $domain ],
			$base
		);

		/**
		 * Final override if needed.
		 */
		$src = (string) apply_filters( 'era_system_widget_src', $src, $domain );

		return $src;
	}

	public function add_era_system_status_widget(): void {
		// Show for logged-in users who can access dashboard
		if ( ! is_user_logged_in() ) {
			return;
		}

		// If you want this only for admins, swap to: current_user_can('manage_options')
		if ( ! current_user_can( 'read' ) ) {
			return;
		}

		wp_add_dashboard_widget(
			'era_system_status_widget',
			__( 'ERA System status', 'era-minimal-admin-view' ),
			[ $this, 'render_era_system_status_widget' ]
		);
	}

	public function render_era_system_status_widget(): void {
		$src = $this->get_widget_src_url();

		// A bit of CSS so iframe looks clean in WP dashboard
		echo '<style>
			#era_system_status_widget .inside { margin: 0; padding: 0; }
			#era_system_status_widget iframe { width: 100%; border: 0; min-height: 560px; }
			#era_system_status_widget .era-widget-meta { padding: 10px 12px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
			#era_system_status_widget .era-widget-meta a { color: #2271b1; }
		</style>';

		printf(
			'<iframe loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="%s" title="%s"></iframe>',
			esc_url( $src ),
			esc_attr__( 'ERA System status', 'era-minimal-admin-view' )
		);

		printf(
			'<div class="era-widget-meta">Domain: <strong>%s</strong> &nbsp;|&nbsp; <a href="%s" target="_blank" rel="noopener noreferrer">Open full view</a></div>',
			esc_html( $this->get_site_domain_for_widget() ),
			esc_url( $src )
		);
	}

	/**
	 * Remove specific items from the admin bar in backend and frontend.
	 */
	public function clean_admin_bar_menu(): void {
		if ( $this->show_all() ) {
			return;
		}

		global $wp_admin_bar;
		$remove = [
			'wp-logo',
			'comments',
			'updates',
			'new-content',
			'customize',
			'gravityforms-new-form',
			'gform-forms',
			'gform-forms-view-all',
			'gform-forms-new-form',
			'woocommerce-site-visibility-badge',
		];

		foreach ( $wp_admin_bar->get_nodes() as $node ) {
			if ( in_array( $node->id, $remove, true ) ) {
				$wp_admin_bar->remove_node( $node->id );
			}
		}
	}

	/**
	 * Remove widgets from dashboard (but keep our ERA widget).
	 */
	public function wp_dashboard_setup(): void {
		if ( $this->show_all() ) {
			return;
		}

		// WordPress specific.
		remove_meta_box( 'dashboard_quick_press', 'dashboard', 'side' );
		remove_meta_box( 'dashboard_primary', 'dashboard', 'side' );
		remove_meta_box( 'dashboard_activity', 'dashboard', 'normal' );
		remove_meta_box( 'dashboard_site_health', 'dashboard', 'normal' );
		remove_meta_box( 'dashboard_right_now', 'dashboard', 'normal' );

		// Plugin specific.
		remove_meta_box( 'wc_admin_dashboard_setup', 'dashboard', 'normal' );
		remove_meta_box( 'rg_forms_dashboard', 'dashboard', 'normal' );
		remove_meta_box( 'wpseo-dashboard-overview', 'dashboard', 'normal' );
		remove_meta_box( 'wpseo-wincher-dashboard-overview', 'dashboard', 'normal' );

		// IMPORTANT: Do NOT remove our widget (id: era_system_status_widget)
	}

	/**
	 * Modify submenu items based on a whitelist or blacklist.
	 */
	public function admin_sub_menu( array &$submenu, string $parent, array $sub_pages, bool $is_whitelist = false ): void {
		if ( ! isset( $submenu[ $parent ] ) ) {
			return;
		}
		foreach ( $submenu[ $parent ] as $index => $sub_menu_item ) {
			$slug    = $sub_menu_item[2];
			$in_list = in_array( $slug, $sub_pages, true );
			if ( $is_whitelist ? ! $in_list : $in_list ) {
				unset( $submenu[ $parent ][ $index ] );
			}
		}
	}

	/**
	 * Remove menu items from the sidebar menu.
	 */
	public function admin_menu(): void {
		if ( $this->show_all() ) {
			return;
		}

		global $menu, $submenu;

		$this->admin_sub_menu( $submenu, 'woocommerce', [
			'wc-admin',
			'wc-settings',
			'wc-status',
			'wc-addons',
			'wc-admin&path=/extensions'
		] );
		$this->admin_sub_menu( $submenu, 'gf_edit_forms', [
			'gf_settings',
			'gf_system_status',
			'gf_addons',
			'gf_export'
		] );

		$this->admin_sub_menu( $submenu, 'themes.php', [ 'nav-menus.php', 'widgets.php' ], true );

		$allowed = [
			'index.php',
			'upload.php',
			'edit.php',
			'nav-menus.php',
			'widgets.php',
			'wp-help-documents',
			'kinsta-cache',
			'admin.php',
			'gf_edit_forms',
			'msf-donations-settings',
			'era-donations-settings'
		];

		$post_types = get_post_types( [], 'objects' );
		foreach ( $post_types as $pt ) {
			if ( ! empty( $pt->show_in_menu ) ) {
				$allowed[] = is_string( $pt->show_in_menu ) ? $pt->show_in_menu : 'edit.php?post_type=' . $pt->name;
			}
		}

		foreach ( $menu as $k => $item ) {
			if ( ( ! in_array( $item[2], $allowed, true ) && $item[2] !== 'themes.php' ) && ! str_contains( $item[2], 'separator' ) ) {
				remove_menu_page( $item[2] );
			}
		}
		ksort( $menu );
		foreach ( $menu as $k => $item ) {
			if ( $item[2] === 'upload.php' ) {
				$media = $menu[ $k ];
				unset( $menu[ $k ] );
				array_splice( $menu, 1, 0, [ $media ] );
				break;
			}
		}
	}

	/**
	 * Add admin bar menu item toggle button.
	 */
	public function render_toggle_button( WP_Admin_Bar $wp_admin_bar ): void {
		if ( ! is_user_logged_in() ) {
			return;
		}
		$label_text = esc_html__( 'Admin view: Minimal', 'era-minimal-admin-view' );
		if ( $this->show_all() ) {
			$label_text = esc_html__( 'Admin view: Advanced', 'era-minimal-admin-view' );
		}
		$label = sprintf( '<span class="ab-icon"></span>%s', $label_text );
		$url   = add_query_arg( $this->toggle_url, '1' );
		$wp_admin_bar->add_node( [
			'id'     => 'era-admin-toggle',
			'title'  => $label,
			'href'   => $url,
			'parent' => 'top-secondary'
		] );
	}

	/**
	 * Handle toggling of admin view mode.
	 */
	public function toggle_state(): void {
		if ( ! is_user_logged_in() || ! isset( $_GET[ $this->toggle_url ] ) ) {
			return;
		}
		$current = $this->show_all() ? '0' : '1';
		update_user_meta( get_current_user_id(), 'era_show_all_admin', $current );
		wp_redirect( remove_query_arg( sanitize_text_field( $this->toggle_url ) ) );
		exit;
	}

	/**
	 * Unload WooCommerce Marketing feature.
	 */
	public function woocommerce_admin_features( array $features ): array {
		if ( $this->show_all() ) {
			return $features;
		}

		return array_filter( $features, function ( $feature ) {
			return $feature !== 'marketing';
		} );
	}

	/**
	 * Check if user has enabled advanced mode.
	 */
	public function show_all(): bool {
		return get_user_meta( get_current_user_id(), 'era_show_all_admin', true ) === '1';
	}

	/**
	 * Add styles to admin head.
	 */
	public function admin_head(): void {
		echo '<style>';
		if ( $this->show_all() ) {
			$icon  = '\f177';
			$color = 'color:#00a32a;';
		} else {
			$color = '';
			$icon  = '\f530';
		}
		printf( '#wpadminbar #wp-admin-bar-era-admin-toggle .ab-icon:before{content:"%s";top:2px;%s}', $icon, $color );
		echo '</style>';
	}

}

new Era_Minimal_Admin_View();
