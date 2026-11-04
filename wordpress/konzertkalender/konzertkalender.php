<?php
/**
 * Plugin Name: Konzertkalender
 * Description: Konzerttermine aus der Region (Freiburg, Karlsruhe, Schweiz) – werden über die REST-API befüllt und per Shortcode [konzertkalender] als Liste angezeigt.
 * Version: 0.4.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Text Domain: konzertkalender
 *
 * REST-API (Anwendungspasswort eines Benutzers mit „edit_posts“):
 *   POST /wp-json/konzertkalender/v1/sync    { "source": "vaddi", "replace": true, "events": [ … ] }
 *   GET  /wp-json/konzertkalender/v1/bestand                             alle kommenden Termine, auch Entwürfe – zum Abgleich vor dem Übertragen
 *   GET  /wp-json/konzertkalender/v1/events  ?tage=90&land=DE,CH&ort=Freiburg  (öffentlich)
 *
 * Anzeige: Shortcode [konzertkalender] (volle Liste), [konzertkalender kompakt="ja" anzahl="8" link="/konzerte/"]
 * oder das Widget „Konzertkalender“ für die Seitenleiste (Design → Widgets).
 *
 * Ein Termin: uid, date (YYYY-MM-DD), time (HH:MM, optional), artists [ … ], title, venue, city,
 * country (DE/CH/FR …), info (Freitext: Preis, Einlass, Support …), url, status (ausverkauft/verschoben/abgesagt).
 */

if (!defined('ABSPATH')) exit;

const KK_POST_TYPE = 'kk_event';
const KK_FIELDS = ['uid', 'source', 'date', 'time', 'artists', 'venue', 'city', 'country', 'info', 'url', 'status'];

add_action('init', function () {
    register_post_type(KK_POST_TYPE, [
        'labels' => [
            'name' => 'Konzerte',
            'singular_name' => 'Konzert',
            'add_new_item' => 'Konzert hinzufügen',
            'edit_item' => 'Konzert bearbeiten',
            'search_items' => 'Konzerte durchsuchen',
            'not_found' => 'Keine Konzerte gefunden',
        ],
        'public' => false,
        'show_ui' => true,
        'show_in_menu' => true,
        'menu_icon' => 'dashicons-calendar-alt',
        'supports' => ['title'],
        'capability_type' => 'post',
    ]);
    add_shortcode('konzertkalender', 'kk_shortcode');
});

/* ---------------------------------------------------------------- Daten */

function kk_today() {
    return wp_date('Y-m-d');
}

/** Felder eines Termins aus den Meta-Daten lesen. */
function kk_event($post) {
    $e = ['id' => $post->ID, 'title' => $post->post_title];
    foreach (KK_FIELDS as $f) $e[$f] = (string) get_post_meta($post->ID, "kk_$f", true);
    $e['artists'] = array_values(array_filter(array_map('trim', explode("\n", $e['artists']))));
    $e['locked'] = (bool) get_post_meta($post->ID, 'kk_locked', true);
    return $e;
}

/** Eingehenden Termin prüfen und bereinigen – null, wenn er unbrauchbar ist. */
function kk_clean($raw, $source) {
    if (!is_array($raw)) return null;
    $date = isset($raw['date']) ? (string) $raw['date'] : '';
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) return null;
    $time = isset($raw['time']) ? (string) $raw['time'] : '';
    if ($time !== '' && !preg_match('/^\d{2}:\d{2}$/', $time)) $time = '';
    $artists = isset($raw['artists']) && is_array($raw['artists']) ? $raw['artists'] : [];
    $artists = array_values(array_filter(array_map(function ($a) { return sanitize_text_field((string) $a); }, $artists)));
    $title = sanitize_text_field(isset($raw['title']) ? (string) $raw['title'] : '');
    if (!$artists && $title === '') return null;
    $uid = sanitize_text_field(isset($raw['uid']) ? (string) $raw['uid'] : '');
    if ($uid === '') return null;
    $str = function ($k) use ($raw) { return isset($raw[$k]) ? sanitize_text_field((string) $raw[$k]) : ''; };
    return [
        'uid' => $uid,
        'source' => $source,
        'date' => $date,
        'time' => $time,
        'artists' => implode("\n", $artists),
        'title' => $title !== '' ? $title : implode(', ', $artists),
        'venue' => $str('venue'),
        'city' => $str('city'),
        'country' => strtoupper(substr($str('country'), 0, 2)),
        'info' => sanitize_textarea_field(isset($raw['info']) ? (string) $raw['info'] : ''),
        'url' => esc_url_raw(isset($raw['url']) ? (string) $raw['url'] : ''),
        'status' => $str('status'),
    ];
}

function kk_save($post_id, $e) {
    foreach (KK_FIELDS as $f) update_post_meta($post_id, "kk_$f", $e[$f]);
    // zum Sortieren: Datum + Uhrzeit (ohne Uhrzeit ans Tagesende)
    update_post_meta($post_id, 'kk_start', $e['date'] . ' ' . ($e['time'] !== '' ? $e['time'] : '23:59'));
}

/**
 * Termine einer Quelle anlegen oder aktualisieren. Mit replace werden künftige Termine dieser Quelle,
 * die nicht mehr geliefert werden, gelöscht (abgesagt/entfernt). Gesperrte Termine bleiben unangetastet,
 * und der Veröffentlichungsstatus vorhandener Termine bleibt erhalten (z. B. von Hand ausgeblendet).
 */
function kk_sync(WP_REST_Request $req) {
    $source = sanitize_key((string) $req->get_param('source'));
    if ($source === '' || $source === 'manuell') return new WP_Error('kk_source', 'source fehlt oder ist ungültig', ['status' => 400]);
    $events = $req->get_param('events');
    if (!is_array($events)) return new WP_Error('kk_events', 'events muss eine Liste sein', ['status' => 400]);
    $status = $req->get_param('post_status') === 'draft' ? 'draft' : 'publish';

    // vorhandene Termine der Quelle: uid → Post-ID
    $existing = [];
    $ids = get_posts([
        'post_type' => KK_POST_TYPE, 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids',
        'meta_key' => 'kk_source', 'meta_value' => $source,
    ]);
    foreach ($ids as $id) $existing[(string) get_post_meta($id, 'kk_uid', true)] = $id;

    $result = ['created' => 0, 'updated' => 0, 'locked' => 0, 'deleted' => 0, 'invalid' => 0];
    $seen = [];
    foreach ($events as $raw) {
        $e = kk_clean($raw, $source);
        if (!$e) { $result['invalid']++; continue; }
        $seen[$e['uid']] = true;
        $id = isset($existing[$e['uid']]) ? $existing[$e['uid']] : 0;
        if ($id && get_post_meta($id, 'kk_locked', true)) { $result['locked']++; continue; }
        if ($id) {
            wp_update_post(['ID' => $id, 'post_title' => $e['title']]);
            $result['updated']++;
        } else {
            $id = wp_insert_post(['post_type' => KK_POST_TYPE, 'post_status' => $status, 'post_title' => $e['title']], true);
            if (is_wp_error($id)) return $id;
            $result['created']++;
        }
        kk_save($id, $e);
    }

    if ($req->get_param('replace')) {
        $today = kk_today();
        foreach ($existing as $uid => $id) {
            if (isset($seen[$uid]) || get_post_meta($id, 'kk_locked', true)) continue;
            if ((string) get_post_meta($id, 'kk_date', true) < $today) continue; // Vergangenes räumt der tägliche Job ab
            wp_delete_post($id, true);
            $result['deleted']++;
        }
    }
    return $result;
}

/** Kommende Termine, sortiert nach Beginn. */
function kk_query($args) {
    $days = max(1, min(730, (int) ($args['tage'] ?? 90)));
    $meta = [
        'relation' => 'AND',
        ['key' => 'kk_date', 'value' => [kk_today(), wp_date('Y-m-d', time() + $days * DAY_IN_SECONDS)], 'compare' => 'BETWEEN', 'type' => 'CHAR'],
    ];
    $list = function ($v) { return array_values(array_filter(array_map('trim', explode(',', (string) $v)))); };
    if (!empty($args['land'])) $meta[] = ['key' => 'kk_country', 'value' => array_map('strtoupper', $list($args['land'])), 'compare' => 'IN'];
    if (!empty($args['quelle'])) $meta[] = ['key' => 'kk_source', 'value' => $list($args['quelle']), 'compare' => 'IN'];
    foreach (['ort' => 'kk_city', 'location' => 'kk_venue'] as $param => $key) {
        if (empty($args[$param])) continue;
        $or = ['relation' => 'OR'];
        foreach ($list($args[$param]) as $v) $or[] = ['key' => $key, 'value' => $v, 'compare' => 'LIKE'];
        $meta[] = $or;
    }
    $posts = get_posts([
        'post_type' => KK_POST_TYPE, 'post_status' => 'publish',
        'numberposts' => max(1, min(2000, (int) ($args['limit'] ?? 500))),
        'meta_query' => $meta, 'meta_key' => 'kk_start', 'orderby' => 'meta_value', 'order' => 'ASC',
    ]);
    return array_map('kk_event', $posts);
}

/** Alle Termine ab gestern in jedem Status – damit der Abholer vor dem Übertragen Dubletten erkennt. */
function kk_bestand() {
    $posts = get_posts([
        'post_type' => KK_POST_TYPE, 'post_status' => ['publish', 'draft', 'pending', 'private', 'future'], 'numberposts' => -1,
        'meta_query' => [['key' => 'kk_date', 'value' => wp_date('Y-m-d', time() - DAY_IN_SECONDS), 'compare' => '>=', 'type' => 'CHAR']],
        'meta_key' => 'kk_start', 'orderby' => 'meta_value', 'order' => 'ASC',
    ]);
    return array_map(function ($post) {
        $e = kk_event($post);
        $e['post_status'] = $post->post_status;
        $e['edit_link'] = admin_url('post.php?post=' . $post->ID . '&action=edit');
        if ($e['source'] === '') $e['source'] = 'manuell';
        return $e;
    }, $posts);
}

add_action('rest_api_init', function () {
    register_rest_route('konzertkalender/v1', '/sync', [
        'methods' => 'POST',
        'callback' => 'kk_sync',
        'permission_callback' => function () { return current_user_can('edit_posts'); },
    ]);
    register_rest_route('konzertkalender/v1', '/bestand', [
        'methods' => 'GET',
        'callback' => 'kk_bestand',
        'permission_callback' => function () { return current_user_can('edit_posts'); },
    ]);
    register_rest_route('konzertkalender/v1', '/events', [
        'methods' => 'GET',
        'callback' => function (WP_REST_Request $req) {
            return array_map(function ($e) { unset($e['id'], $e['locked']); return $e; }, kk_query($req->get_params()));
        },
        'permission_callback' => '__return_true',
    ]);
});

/* ---------------------------------------------------------------- Aufräumen */

register_activation_hook(__FILE__, function () {
    if (!wp_next_scheduled('kk_cleanup')) wp_schedule_event(time() + HOUR_IN_SECONDS, 'daily', 'kk_cleanup');
});
register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook('kk_cleanup');
});

/** Termine, die länger als 7 Tage vorbei sind, löschen. */
add_action('kk_cleanup', function () {
    $ids = get_posts([
        'post_type' => KK_POST_TYPE, 'post_status' => 'any', 'numberposts' => 500, 'fields' => 'ids',
        'meta_query' => [['key' => 'kk_date', 'value' => wp_date('Y-m-d', time() - 7 * DAY_IN_SECONDS), 'compare' => '<', 'type' => 'CHAR']],
    ]);
    foreach ($ids as $id) wp_delete_post($id, true);
});

/* ---------------------------------------------------------------- Anzeige */

const KK_HINWEIS = 'Alle Angaben ohne Gewähr. Termine, Preise und Besetzungen können sich ändern – maßgeblich sind immer die Angaben des Veranstalters. Der Link bei jedem Termin führt zur Quelle.';

/** Haftungshinweis unter der Liste: Standardtext, eigener Text oder „aus“. */
function kk_hinweis($text, $short = false) {
    if (in_array(strtolower(trim((string) $text)), ['aus', 'nein', '0', 'false'], true)) return '';
    $t = trim((string) $text) !== '' ? $text : ($short ? 'Angaben ohne Gewähr – maßgeblich sind die Angaben des Veranstalters.' : KK_HINWEIS);
    return sprintf('<p class="kk-hinweis">%s</p>', esc_html($t));
}

/** Kurze Liste der nächsten Konzerte – für die Seitenleiste. */
function kk_render_compact($events, $more_url = '', $hinweis = '') {
    ob_start();
    echo '<div class="konzertkalender kk-compact">';
    if (!$events) {
        echo '<p class="kk-empty">Zurzeit sind keine Konzerte eingetragen.</p>';
    } else {
        echo '<ul class="kk-c-list">';
        foreach ($events as $e) {
            $ts = strtotime($e['date'] . ' 12:00:00');
            $when = date_i18n('D, j.n.', $ts) . ($e['time'] !== '' ? ' · ' . $e['time'] : '');
            $artists = implode(', ', $e['artists'] ?: [$e['title']]);
            $place = implode(', ', array_filter([$e['venue'], $e['city']]));
            if ($e['country'] && $e['country'] !== 'DE') $place .= ' (' . $e['country'] . ')';
            echo '<li class="kk-c-event">';
            printf('<time class="kk-c-date" datetime="%s">%s</time>', esc_attr($e['date']), esc_html($when));
            if ($e['url'] !== '') printf('<a class="kk-c-artists" href="%s" target="_blank" rel="noopener nofollow" title="Infos &amp; Tickets beim Veranstalter">%s</a>', esc_url($e['url']), esc_html($artists));
            else printf('<strong class="kk-c-artists">%s</strong>', esc_html($artists));
            if ($e['status'] !== '') printf(' <span class="kk-status">%s</span>', esc_html($e['status']));
            if ($place !== '') printf('<span class="kk-c-place">%s</span>', esc_html($place));
            echo '</li>';
        }
        echo '</ul>';
    }
    if ($more_url !== '') printf('<a class="kk-c-more" href="%s">Alle Konzerte &rarr;</a>', esc_url($more_url));
    echo kk_hinweis($hinweis, true);
    echo '</div>';
    return ob_get_clean();
}

/** Kleinbuchstaben ohne Akzente – damit „Zürich“ auch mit „zurich“ gefunden wird. */
function kk_fold($text) {
    $text = remove_accents((string) $text);
    return function_exists('mb_strtolower') ? mb_strtolower($text) : strtolower($text);
}

/** Alle Suchwörter müssen in Künstlern, Titel, Location, Ort oder Infos vorkommen. */
function kk_matches($e, $words) {
    $hay = kk_fold(implode(' ', array_merge($e['artists'], [$e['title'], $e['venue'], $e['city'], $e['info']])));
    foreach ($words as $w) if (strpos($hay, $w) === false) return false;
    return true;
}

/** Übrige Parameter der Seite (z. B. ?page_id=…) – bleiben beim Filtern und Zurücksetzen erhalten. */
function kk_keep_params() {
    $keep = [];
    foreach ($_GET as $k => $v) {
        if (in_array($k, ['kk_q', 'kk_monat', 'kk_ort'], true) || !is_string($v)) continue;
        $keep[sanitize_key($k)] = sanitize_text_field(wp_unslash($v));
    }
    return $keep;
}

/**
 * [konzertkalender tage="90" land="DE,CH" ort="Freiburg,Basel" location="Jazzhaus" limit="500" filter="ja"]
 * filter="ja" zeigt Suche, Monat und Ort (über ?kk_q=…&kk_monat=2026-12&kk_ort=… in der Adresse).
 * kompakt="ja" anzahl="8" link="/konzerte/" – kurze Liste der nächsten Konzerte, z. B. für die Seitenleiste.
 * hinweis="…" eigener Haftungshinweis, hinweis="aus" blendet ihn aus.
 */
function kk_shortcode($atts) {
    $atts = shortcode_atts(['tage' => 90, 'land' => '', 'ort' => '', 'location' => '', 'quelle' => '', 'limit' => 500, 'filter' => '', 'kompakt' => '', 'anzahl' => 8, 'link' => '', 'hinweis' => ''], $atts, 'konzertkalender');
    if (in_array(strtolower($atts['kompakt']), ['1', 'ja', 'true', 'yes'], true)) {
        return kk_render_compact(kk_query(array_merge($atts, ['limit' => $atts['anzahl']])), $atts['link'], $atts['hinweis']);
    }
    $show_filter = in_array(strtolower($atts['filter']), ['1', 'ja', 'true', 'yes'], true);
    $get = function ($k) { return isset($_GET[$k]) && is_string($_GET[$k]) ? sanitize_text_field(wp_unslash($_GET[$k])) : ''; };
    $q = $show_filter ? $get('kk_q') : '';
    $month = $show_filter && preg_match('/^\d{4}-\d{2}$/', $get('kk_monat')) ? $get('kk_monat') : '';
    $city = $show_filter ? $get('kk_ort') : '';
    $filtered = $q !== '' || $month !== '' || $city !== '';

    // Für die Auswahl ein Jahr im Voraus laden; ohne Monat und Suche werden nur die nächsten `tage` Tage gezeigt
    $days = (int) $atts['tage'];
    $all = kk_query($show_filter ? array_merge($atts, ['tage' => max($days, 365), 'limit' => 2000]) : $atts);
    $until = wp_date('Y-m-d', time() + $days * DAY_IN_SECONDS);
    $words = array_values(array_filter(preg_split('/\s+/', kk_fold($q))));
    $events = array_values(array_filter($all, function ($e) use ($month, $city, $words, $until, $q) {
        if ($month !== '') {
            if (substr($e['date'], 0, 7) !== $month) return false;
        } elseif ($q === '' && $e['date'] > $until) {
            return false; // eine Suche durchsucht das ganze Jahr
        }
        if ($city !== '' && $e['city'] !== $city) return false;
        return !$words || kk_matches($e, $words);
    }));

    ob_start();
    echo '<div class="konzertkalender">';
    if ($show_filter) {
        $cities = array_unique(array_filter(array_map(function ($e) { return $e['city']; }, $all)));
        sort($cities, SORT_LOCALE_STRING);
        $months = array_unique(array_map(function ($e) { return substr($e['date'], 0, 7); }, $all));
        sort($months);
        echo '<form class="kk-filter" method="get" role="search">';
        foreach (kk_keep_params() as $k => $v) printf('<input type="hidden" name="%s" value="%s">', esc_attr($k), esc_attr($v));
        printf('<label class="kk-f-search"><span>Suche</span><input type="search" name="kk_q" value="%s" placeholder="Band, Künstler, Location …"></label>', esc_attr($q));
        printf('<label><span>Monat</span><select name="kk_monat" onchange="this.form.submit()"><option value="">nächste %d Tage</option>', $days);
        foreach ($months as $m) printf('<option value="%s"%s>%s</option>', esc_attr($m), selected($m, $month, false), esc_html(date_i18n('F Y', strtotime($m . '-15'))));
        echo '</select></label>';
        echo '<label><span>Ort</span><select name="kk_ort" onchange="this.form.submit()"><option value="">alle Orte</option>';
        foreach ($cities as $c) printf('<option value="%1$s"%2$s>%1$s</option>', esc_attr($c), selected($c, $city, false));
        echo '</select></label>';
        echo '<button type="submit">Suchen</button>';
        if ($filtered) {
            $page = get_permalink() ?: home_url('/');
            printf('<a class="kk-f-reset" href="%s">Filter zurücksetzen</a>', esc_url(add_query_arg(kk_keep_params(), $page)));
        }
        echo '</form>';
        if ($filtered) printf('<p class="kk-f-count">%d %s gefunden</p>', count($events), count($events) === 1 ? 'Konzert' : 'Konzerte');
    }
    if (!$events) {
        echo $filtered ? '<p class="kk-empty">Keine Konzerte für diese Auswahl.</p>' : '<p class="kk-empty">Zurzeit sind keine Konzerte eingetragen.</p>';
        echo kk_hinweis($atts['hinweis']) . '</div>';
        return ob_get_clean();
    }

    $day = null;
    foreach ($events as $e) {
        if ($e['date'] !== $day) {
            if ($day !== null) echo '</ul>';
            $day = $e['date'];
            $ts = strtotime($day . ' 12:00:00');
            printf('<h3 class="kk-day"><time datetime="%s">%s</time></h3><ul class="kk-list">', esc_attr($day), esc_html(date_i18n('l, j. F Y', $ts)));
        }
        $artists = $e['artists'] ?: [$e['title']];
        $place = implode(', ', array_filter([$e['venue'], $e['city']]));
        if ($e['country'] && $e['country'] !== 'DE') $place .= ' (' . $e['country'] . ')';
        echo '<li class="kk-event">';
        if ($e['time'] !== '') printf('<span class="kk-time">%s&nbsp;Uhr</span> ', esc_html($e['time']));
        printf('<strong class="kk-artists">%s</strong>', esc_html(implode(', ', $artists)));
        if ($e['status'] !== '') printf(' <span class="kk-status">%s</span>', esc_html($e['status']));
        if ($place !== '') printf('<span class="kk-place">%s</span>', esc_html($place));
        if ($e['info'] !== '') printf('<span class="kk-info">%s</span>', nl2br(esc_html($e['info'])));
        if ($e['url'] !== '') printf('<a class="kk-link" href="%s" target="_blank" rel="noopener nofollow">Infos &amp; Tickets beim Veranstalter</a>', esc_url($e['url']));
        echo '</li>';
    }
    echo '</ul>';
    echo kk_hinweis($atts['hinweis']);
    echo '</div>';
    return ob_get_clean();
}

add_action('wp_head', function () {
    ?>
<style id="konzertkalender-css">
.konzertkalender .kk-day{margin:1.6em 0 .4em;font-size:1.1em}
.konzertkalender .kk-list{list-style:none;margin:0;padding:0}
.konzertkalender .kk-event{padding:.6em 0;border-bottom:1px solid rgba(127,127,127,.25)}
.konzertkalender .kk-time{opacity:.75;margin-right:.3em}
.konzertkalender .kk-status{font-size:.8em;padding:.1em .45em;border:1px solid currentColor;border-radius:3px;text-transform:uppercase}
.konzertkalender .kk-place,.konzertkalender .kk-info{display:block;font-size:.92em}
.konzertkalender .kk-info{opacity:.8}
.konzertkalender .kk-link{font-size:.9em}
.konzertkalender .kk-filter{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.6em 1em;margin:0 0 1.2em;padding:.9em 1em;border:1px solid rgba(127,127,127,.25);border-radius:6px}
.konzertkalender .kk-filter label{display:flex;flex-direction:column;gap:.25em;font-size:.85em;margin:0}
.konzertkalender .kk-filter label span{font-weight:600;opacity:.8}
.konzertkalender .kk-filter .kk-f-search{flex:1 1 14em}
.konzertkalender .kk-filter input,.konzertkalender .kk-filter select{width:100%;min-height:2.3em;margin:0;box-sizing:border-box}
.konzertkalender .kk-filter button{min-height:2.3em;margin:0}
.konzertkalender .kk-f-reset{font-size:.85em;align-self:center}
.konzertkalender .kk-f-count{font-size:.9em;opacity:.75;margin:-.4em 0 .8em}
.konzertkalender .kk-hinweis{margin-top:1.4em;font-size:.8em;opacity:.65;line-height:1.45}
.kk-compact .kk-hinweis{margin-top:.8em;font-size:.72em}
.kk-compact .kk-c-list{list-style:none;margin:0;padding:0}
.kk-compact .kk-c-event{padding:.55em 0;border-bottom:1px solid rgba(127,127,127,.2);line-height:1.35}
.kk-compact .kk-c-event:last-child{border-bottom:0}
.kk-compact .kk-c-date{display:block;font-size:.8em;text-transform:uppercase;letter-spacing:.03em;opacity:.65}
.kk-compact .kk-c-artists{font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.kk-compact .kk-c-place{display:block;font-size:.88em;opacity:.8}
.kk-compact .kk-status{font-size:.7em}
.kk-compact .kk-c-more{display:inline-block;margin-top:.6em;font-size:.9em;font-weight:600}
</style>
    <?php
});

/* ---------------------------------------------------------------- Widget */

/** Seitenleisten-Widget: die nächsten Konzerte, optional nach Ort/Land, mit Link zur vollen Liste. */
class KK_Widget extends WP_Widget {
    const DEFAULTS = ['title' => 'Konzerte', 'anzahl' => 8, 'tage' => 60, 'land' => '', 'ort' => '', 'link' => '', 'hinweis' => ''];

    public function __construct() {
        parent::__construct('konzertkalender', 'Konzertkalender', ['description' => 'Die nächsten Konzerte aus dem Konzertkalender']);
    }

    public function widget($args, $instance) {
        $o = wp_parse_args($instance, self::DEFAULTS);
        $events = kk_query(['tage' => $o['tage'], 'land' => $o['land'], 'ort' => $o['ort'], 'limit' => $o['anzahl']]);
        echo $args['before_widget'];
        if ($o['title'] !== '') echo $args['before_title'] . esc_html(apply_filters('widget_title', $o['title'], $instance, $this->id_base)) . $args['after_title'];
        echo kk_render_compact($events, $o['link'], $o['hinweis']);
        echo $args['after_widget'];
    }

    public function form($instance) {
        $o = wp_parse_args($instance, self::DEFAULTS);
        $fields = [
            'title' => ['Überschrift', 'text'],
            'anzahl' => ['Anzahl Konzerte', 'number'],
            'tage' => ['Zeitraum (Tage ab heute)', 'number'],
            'ort' => ['Nur diese Orte (Komma, leer = alle)', 'text'],
            'land' => ['Nur diese Länder, z. B. DE,CH (leer = alle)', 'text'],
            'link' => ['Link „Alle Konzerte“ (Seite mit [konzertkalender])', 'url'],
            'hinweis' => ['Haftungshinweis (leer = Standard, „aus“ = keiner)', 'text'],
        ];
        foreach ($fields as $key => [$label, $type]) {
            printf(
                '<p><label for="%1$s">%2$s</label><input class="widefat" type="%3$s" id="%1$s" name="%4$s" value="%5$s"></p>',
                esc_attr($this->get_field_id($key)), esc_html($label), esc_attr($type), esc_attr($this->get_field_name($key)), esc_attr($o[$key])
            );
        }
    }

    public function update($new, $old) {
        return [
            'title' => sanitize_text_field($new['title'] ?? ''),
            'anzahl' => max(1, min(50, (int) ($new['anzahl'] ?? 8))),
            'tage' => max(1, min(730, (int) ($new['tage'] ?? 60))),
            'ort' => sanitize_text_field($new['ort'] ?? ''),
            'land' => strtoupper(sanitize_text_field($new['land'] ?? '')),
            'link' => esc_url_raw($new['link'] ?? ''),
            'hinweis' => sanitize_text_field($new['hinweis'] ?? ''),
        ];
    }
}

add_action('widgets_init', function () {
    register_widget('KK_Widget');
});

/* ---------------------------------------------------------------- Admin */

add_action('add_meta_boxes', function () {
    add_meta_box('kk_details', 'Termin', 'kk_meta_box', KK_POST_TYPE, 'normal', 'high');
});

function kk_meta_box($post) {
    $e = kk_event($post);
    wp_nonce_field('kk_save', 'kk_nonce');
    $row = function ($name, $label, $value, $type = 'text') {
        printf('<p><label for="kk_%1$s"><strong>%2$s</strong></label><br>', esc_attr($name), esc_html($label));
        if ($type === 'textarea') printf('<textarea id="kk_%1$s" name="kk_%1$s" rows="3" class="large-text">%2$s</textarea></p>', esc_attr($name), esc_textarea($value));
        else printf('<input type="%3$s" id="kk_%1$s" name="kk_%1$s" value="%2$s" class="regular-text"></p>', esc_attr($name), esc_attr($value), esc_attr($type));
    };
    $row('date', 'Datum', $e['date'], 'date');
    $row('time', 'Beginn', $e['time'], 'time');
    $row('artists', 'Künstler (einer pro Zeile)', implode("\n", $e['artists']), 'textarea');
    $row('venue', 'Location', $e['venue']);
    $row('city', 'Ort', $e['city']);
    $row('country', 'Land (DE, CH, FR …)', $e['country']);
    $row('info', 'Infos (Preis, Einlass, Support …)', $e['info'], 'textarea');
    $row('url', 'Link (Infos/Tickets)', $e['url'], 'url');
    $row('status', 'Hinweis (z. B. ausverkauft, verschoben)', $e['status']);
    printf('<p><label><input type="checkbox" name="kk_locked" value="1"%s> Nicht automatisch überschreiben oder löschen</label></p>', checked($e['locked'], true, false));
    printf('<p class="description">Quelle: %s%s</p>', esc_html($e['source'] ?: 'manuell'), $e['uid'] ? ' · ' . esc_html($e['uid']) : '');
}

add_action('save_post_' . KK_POST_TYPE, function ($post_id) {
    if (!isset($_POST['kk_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['kk_nonce'])), 'kk_save')) return;
    if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) return;
    if (!current_user_can('edit_post', $post_id)) return;
    $old = kk_event(get_post($post_id));
    $raw = [];
    foreach (['date', 'time', 'venue', 'city', 'country', 'info', 'url', 'status'] as $f) {
        $raw[$f] = isset($_POST["kk_$f"]) ? wp_unslash($_POST["kk_$f"]) : '';
    }
    $raw['artists'] = isset($_POST['kk_artists']) ? explode("\n", wp_unslash($_POST['kk_artists'])) : [];
    $raw['title'] = get_post_field('post_title', $post_id);
    $raw['uid'] = $old['uid'] !== '' ? $old['uid'] : 'manuell:' . $post_id;
    $e = kk_clean($raw, $old['source'] !== '' ? $old['source'] : 'manuell');
    if ($e) kk_save($post_id, $e);
    update_post_meta($post_id, 'kk_locked', empty($_POST['kk_locked']) ? '' : '1');
});

add_filter('manage_' . KK_POST_TYPE . '_posts_columns', function ($cols) {
    return ['cb' => $cols['cb'], 'title' => 'Konzert', 'kk_date' => 'Datum', 'kk_place' => 'Location', 'kk_source' => 'Quelle', 'date' => $cols['date']];
});
add_action('manage_' . KK_POST_TYPE . '_posts_custom_column', function ($col, $post_id) {
    $e = kk_event(get_post($post_id));
    if ($col === 'kk_date') echo esc_html(trim($e['date'] . ' ' . $e['time']));
    if ($col === 'kk_place') echo esc_html(implode(', ', array_filter([$e['venue'], $e['city'], $e['country']])));
    if ($col === 'kk_source') echo esc_html(($e['source'] ?: 'manuell') . ($e['locked'] ? ' 🔒' : ''));
}, 10, 2);
add_filter('manage_edit-' . KK_POST_TYPE . '_sortable_columns', function ($cols) {
    $cols['kk_date'] = 'kk_date';
    return $cols;
});
add_action('pre_get_posts', function ($q) {
    if (!is_admin() || !$q->is_main_query() || $q->get('post_type') !== KK_POST_TYPE) return;
    if (!$q->get('orderby') || $q->get('orderby') === 'kk_date') {
        $q->set('meta_key', 'kk_start');
        $q->set('orderby', 'meta_value');
        if (!$q->get('order')) $q->set('order', 'ASC');
    }
});
