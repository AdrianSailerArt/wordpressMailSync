<?php
/**
 * Plugin Name: Pressbot SEO-Meta
 * Description: Macht die SEO-Felder von Yoast und Rank Math über die REST-API beschreibbar, damit pressbot Meta-Description, SEO-Titel und Fokus-Keyword setzen kann.
 * Version: 0.1.0
 *
 * Installation: Datei nach wp-content/mu-plugins/ kopieren (Ordner ggf. anlegen).
 */

add_action('init', function () {
    $keys = [
        '_yoast_wpseo_title', '_yoast_wpseo_metadesc', '_yoast_wpseo_focuskw',
        'rank_math_title', 'rank_math_description', 'rank_math_focus_keyword',
    ];
    foreach ($keys as $key) {
        register_post_meta('post', $key, [
            'type'          => 'string',
            'single'        => true,
            'show_in_rest'  => true,
            'auth_callback' => function () {
                return current_user_can('edit_posts');
            },
        ]);
    }
});
