<?php
/**
 * Karte zum Konzertkalender – ganz ohne API-Schlüssel:
 *  - Leaflet liegt im Plugin (vendor/leaflet), wird also vom eigenen Server geladen.
 *  - Kartenkacheln kommen von OpenStreetMap (oder einem anderen Kachel-Server, einstellbar). Das ist ein
 *    Drittanbieter, der die IP-Adresse der Besucher sieht – deshalb lädt die Karte erst nach Zustimmung.
 *  - Koordinaten der Locations sucht der WordPress-Server bei Nominatim (OpenStreetMap), höchstens eine
 *    Anfrage pro Sekunde, im Hintergrund per WP-Cron und dauerhaft zwischengespeichert. Dabei gehen nur
 *    Location und Ort an Nominatim, keine Daten von Besuchern. Ticketmaster liefert Koordinaten gleich mit.
 *
 * Einstellungen und Korrekturen von Hand: Konzerte → Karte.
 */

if (!defined('ABSPATH')) exit;

const KK_NOMINATIM = 'https://nominatim.openstreetmap.org/search';
/** so viele Orte sucht ein Durchlauf, danach geht es zwei Minuten später weiter */
const KK_GEO_BATCH = 15;
/** nicht gefundene Orte erst nach 30 Tagen erneut suchen */
const KK_GEO_RETRY = 30 * DAY_IN_SECONDS;

/* ---------------------------------------------------------------- Einstellungen */

function kk_karte_defaults() {
    return [
        'anbieter' => 'OpenStreetMap',
        'tiles' => 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        'attribution' => '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
        'anbieter_datenschutz' => 'https://osmfoundation.org/wiki/Privacy_Policy',
        'datenschutz' => '',
        'zustimmung' => '1',
    ];
}

function kk_karte_settings() {
    $s = wp_parse_args((array) get_option('kk_karte', []), kk_karte_defaults());
    if ($s['datenschutz'] === '') $s['datenschutz'] = (string) get_privacy_policy_url();
    return $s;
}

/** Muss vor dem Laden gefragt werden? Abschaltbar, z. B. wenn ein Consent-Tool das übernimmt oder die Kacheln vom eigenen Server kommen. */
function kk_karte_zustimmung_noetig() {
    return (bool) apply_filters('kk_karte_zustimmung', kk_karte_settings()['zustimmung'] === '1');
}

/* ---------------------------------------------------------------- Koordinaten */

/** Schlüssel einer Location: Name, Ort und Land ohne Akzente und Groß-/Kleinschreibung. */
function kk_place_key($venue, $city, $country) {
    return md5(kk_fold($venue) . '|' . kk_fold($city) . '|' . strtoupper((string) $country));
}

/**
 * Zwischenspeicher: Schlüssel → venue, city, country, lat, lon, art, t.
 * art: hand (von Hand), quelle (vom Abholer, z. B. Ticketmaster), suche (Nominatim), ort (nur Ortsmitte gefunden), fehlt.
 */
function kk_geo_all() {
    $geo = get_option('kk_geo', []);
    return is_array($geo) ? $geo : [];
}

function kk_geo_save($geo) {
    update_option('kk_geo', $geo, false);
}

/** Koordinaten aus dem Abruf übernehmen – von Hand gesetzte bleiben. */
function kk_geo_learn(&$geo, $e, $lat, $lon) {
    if (!is_numeric($lat) || !is_numeric($lon)) return;
    $lat = (float) $lat;
    $lon = (float) $lon;
    if (abs($lat) > 90 || abs($lon) > 180 || ($lat == 0 && $lon == 0)) return;
    $key = kk_place_key($e['venue'], $e['city'], $e['country']);
    if (isset($geo[$key]) && $geo[$key]['art'] === 'hand') return;
    $geo[$key] = ['venue' => $e['venue'], 'city' => $e['city'], 'country' => $e['country'], 'lat' => round($lat, 6), 'lon' => round($lon, 6), 'art' => 'quelle', 't' => time()];
}

/** Ohne Koordinaten oder mit veraltetem „nicht gefunden“? */
function kk_geo_open($entry) {
    if (!$entry) return true;
    return $entry['art'] === 'fehlt' && (int) $entry['t'] < time() - KK_GEO_RETRY;
}

/** Alle Locations kommender, veröffentlichter Termine: Schlüssel → venue, city, country, count. */
function kk_places() {
    $places = [];
    foreach (kk_query(['tage' => 730, 'limit' => 2000]) as $e) {
        if ($e['venue'] === '' && $e['city'] === '') continue;
        $key = kk_place_key($e['venue'], $e['city'], $e['country']);
        if (!isset($places[$key])) $places[$key] = ['venue' => $e['venue'], 'city' => $e['city'], 'country' => $e['country'], 'count' => 0];
        $places[$key]['count']++;
    }
    return $places;
}

/**
 * Eine Suche bei Nominatim. Liefert [lat, lon], [] für „nichts gefunden“ oder null bei einem Fehler
 * (dann wird nichts gespeichert und später erneut gesucht).
 */
function kk_nominatim($q, $country) {
    $args = ['format' => 'jsonv2', 'limit' => 1, 'q' => $q, 'accept-language' => 'de'];
    if ($country !== '') $args['countrycodes'] = strtolower($country);
    $res = wp_remote_get(add_query_arg(array_map('rawurlencode', $args), KK_NOMINATIM), [
        'timeout' => 10,
        // Nominatim verlangt eine erkennbare Anwendung
        'user-agent' => 'Konzertkalender/' . KK_VERSION . ' (WordPress-Plugin; ' . home_url('/') . ')',
        'headers' => ['Referer' => home_url('/')],
    ]);
    if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) return null;
    $body = json_decode(wp_remote_retrieve_body($res), true);
    if (!is_array($body)) return null;
    if (!$body || !isset($body[0]['lat'], $body[0]['lon'])) return [];
    return [round((float) $body[0]['lat'], 6), round((float) $body[0]['lon'], 6)];
}

/**
 * Fehlende Koordinaten suchen: erst „Location, Ort“, sonst nur der Ort (ungefähr, Ortsmitte).
 * Höchstens eine Anfrage pro Sekunde (Nutzungsregeln von Nominatim). Gibt zurück, was passiert ist.
 */
function kk_geocode_run($max = KK_GEO_BATCH) {
    $geo = kk_geo_all();
    $open = array_filter(kk_places(), function ($p, $key) use ($geo) {
        return kk_geo_open(isset($geo[$key]) ? $geo[$key] : null);
    }, ARRAY_FILTER_USE_BOTH);
    $done = ['gefunden' => 0, 'ungefaehr' => 0, 'fehlt' => 0, 'fehler' => 0, 'offen' => 0];
    $requests = 0;
    $ask = function ($q, $country) use (&$requests) {
        if ($requests++ > 0) sleep(1);
        return kk_nominatim($q, $country);
    };
    foreach (array_slice($open, 0, $max, true) as $key => $p) {
        $hit = $p['venue'] !== '' && $p['city'] !== '' ? $ask($p['venue'] . ', ' . $p['city'], $p['country']) : [];
        $art = 'suche';
        if ($hit === []) {
            $hit = $ask($p['city'] !== '' ? $p['city'] : $p['venue'], $p['country']);
            $art = 'ort';
        }
        if ($hit === null) { $done['fehler']++; break; } // Netz oder Sperre: später weiter
        $entry = ['venue' => $p['venue'], 'city' => $p['city'], 'country' => $p['country'], 'art' => $hit ? $art : 'fehlt', 't' => time()];
        if ($hit) { $entry['lat'] = $hit[0]; $entry['lon'] = $hit[1]; }
        $geo[$key] = $entry;
        $done[$hit ? ($art === 'suche' ? 'gefunden' : 'ungefaehr') : 'fehlt']++;
    }
    kk_geo_save($geo);
    $done['offen'] = max(0, count($open) - $done['gefunden'] - $done['ungefaehr'] - $done['fehlt']);
    if ($done['offen'] > 0) kk_geo_schedule(2 * MINUTE_IN_SECONDS);
    return $done;
}

function kk_geo_schedule($delay = 30) {
    if (!wp_next_scheduled('kk_geocode')) wp_schedule_single_event(time() + $delay, 'kk_geocode');
}

add_action('kk_geocode', function () { kk_geocode_run(); });
register_deactivation_hook(KK_FILE, function () { wp_clear_scheduled_hook('kk_geocode'); });

/** Nach dem Speichern eines Termins von Hand die Koordinaten im Hintergrund nachziehen. */
add_action('save_post_' . KK_POST_TYPE, function () { kk_geo_schedule(); }, 20);

/* ---------------------------------------------------------------- Anzeige */

/** Termine nach Location bündeln, mit Koordinaten aus dem Zwischenspeicher. */
function kk_map_data($events) {
    $geo = kk_geo_all();
    $places = [];
    $missing = [];
    foreach ($events as $e) {
        $key = kk_place_key($e['venue'], $e['city'], $e['country']);
        $g = isset($geo[$key]) ? $geo[$key] : null;
        if (!$g || !isset($g['lat'])) { $missing[$key] = true; continue; }
        if (!isset($places[$key])) {
            $places[$key] = ['n' => $e['venue'] !== '' ? $e['venue'] : $e['city'], 'c' => $e['venue'] !== '' ? $e['city'] : '', 'lat' => $g['lat'], 'lon' => $g['lon'], 'ca' => $g['art'] === 'ort', 'ev' => []];
        }
        $when = date_i18n('D, j.n.', strtotime($e['date'] . ' 12:00:00')) . ($e['time'] !== '' ? ' · ' . $e['time'] : '');
        $places[$key]['ev'][] = ['d' => $e['date'], 'w' => $when, 'a' => implode(', ', $e['artists'] ?: [$e['title']]), 'u' => $e['url'], 's' => $e['status']];
    }
    return ['orte' => array_values($places), 'ohne' => count($missing)];
}

/** Karte mit Platzhalter: Kacheln lädt erst ein Klick auf „Karte laden“ (oder eine gemerkte Zustimmung). */
function kk_render_map($events, $only = false) {
    static $enqueued = false;
    $s = kk_karte_settings();
    $data = kk_map_data($events);
    if (!$enqueued && $data['orte']) {
        $enqueued = true;
        wp_enqueue_script('kk-karte', plugins_url('kk-karte.js', KK_FILE), [], KK_VERSION, true);
        wp_add_inline_script('kk-karte', 'window.kkKarteConfig=' . wp_json_encode([
            'leafletJs' => plugins_url('vendor/leaflet/leaflet.js', KK_FILE) . '?ver=1.9.4',
            'leafletCss' => plugins_url('vendor/leaflet/leaflet.css', KK_FILE) . '?ver=1.9.4',
            'tiles' => $s['tiles'],
            'attribution' => $s['attribution'],
            'zustimmung' => kk_karte_zustimmung_noetig(),
        ]) . ';', 'before');
    }

    $anbieter = esc_html($s['anbieter']);
    $links = [];
    if ($s['anbieter_datenschutz'] !== '') $links[] = sprintf('<a href="%s" target="_blank" rel="noopener">Datenschutz bei %s</a>', esc_url($s['anbieter_datenschutz']), $anbieter);
    if ($s['datenschutz'] !== '') $links[] = sprintf('<a href="%s">Datenschutzerklärung</a>', esc_url($s['datenschutz']));
    $count = count($data['orte']);

    ob_start();
    printf('<section class="kk-karte%s" aria-label="Karte der Konzertorte">', $only ? ' kk-karte-nur' : '');
    printf('<script type="application/json" class="kk-k-daten">%s</script>', wp_json_encode($data['orte'], JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_UNICODE));
    if (!$count) {
        echo '<p class="kk-k-leer">Für diese Auswahl gibt es noch keine Orte auf der Karte.</p></section>';
        return ob_get_clean();
    }
    echo '<div class="kk-k-zustimmung">';
    printf('<p class="kk-k-titel"><strong>Karte mit %d %s</strong></p>', $count, $count === 1 ? 'Ort' : 'Orten');
    printf('<p>Die Karte wird von %1$s geladen. Dabei werden Daten wie Ihre IP-Adresse an %1$s übertragen.%2$s</p>', $anbieter, $links ? ' ' . implode(' · ', $links) : '');
    echo '<p class="kk-k-aktion"><button type="button" class="kk-k-laden">Karte laden</button>';
    echo '<label class="kk-k-merken"><input type="checkbox"> Karte künftig automatisch laden</label></p>';
    echo '<p class="kk-k-status" role="status" aria-live="polite"></p>';
    echo '</div>';
    echo '<div class="kk-k-flaeche" hidden></div>';
    echo '<p class="kk-k-fuss" hidden>';
    echo '<span class="kk-k-info"></span>';
    echo '<button type="button" class="kk-k-widerrufen" hidden>Automatisches Laden der Karte beenden</button>';
    echo '</p>';
    if ($data['ohne'] > 0) printf('<p class="kk-k-ohne">%d %s noch ohne Kartenposition – %s in der Liste.</p>', $data['ohne'], $data['ohne'] === 1 ? 'Ort ist' : 'Orte sind', $data['ohne'] === 1 ? 'seine Termine stehen' : 'ihre Termine stehen');
    echo '</section>';
    return ob_get_clean();
}

add_action('wp_head', function () {
    ?>
<style id="konzertkalender-karte-css">
.kk-karte{--kk-k-akzent:#c2410c;--kk-k-akzent-fg:#fff;--kk-k-popup-fg:#1c1917;--kk-k-popup-muted:#57534e;--kk-k-popup-link:#9a3412;margin:0 0 1.4em}
.kk-karte .kk-k-zustimmung{padding:1em 1.1em;border:1px dashed rgba(127,127,127,.5);border-radius:6px;font-size:.92em;line-height:1.45}
.kk-karte .kk-k-zustimmung p{margin:0 0 .6em}
.kk-karte .kk-k-titel{font-size:1.05em}
.kk-karte .kk-k-aktion{display:flex;flex-wrap:wrap;align-items:center;gap:.6em 1.2em}
.kk-karte .kk-k-laden{min-height:2.75em;margin:0}
.kk-karte .kk-k-merken{display:inline-flex;align-items:center;gap:.4em;min-height:2.75em;cursor:pointer}
.kk-karte .kk-k-merken input{width:1.2em;height:1.2em;margin:0}
.kk-karte .kk-k-status:empty{display:none}
.kk-karte .kk-k-flaeche{height:clamp(18rem,55vh,32rem);border-radius:6px;z-index:0}
.kk-karte .kk-k-flaeche:focus-visible{outline:3px solid var(--kk-k-akzent);outline-offset:2px}
.kk-karte .kk-k-fuss{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.4em 1em;margin:.4em 0 0;font-size:.8em;opacity:.8}
.kk-karte .kk-k-fuss[hidden]{display:none}
.kk-karte .kk-k-widerrufen{background:none;border:0;padding:.2em 0;margin:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer;min-height:24px}
.kk-karte .kk-k-ohne,.kk-karte .kk-k-leer{font-size:.8em;opacity:.7;margin:.4em 0 0}
.kk-karte .kk-k-pin{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:var(--kk-k-akzent);color:var(--kk-k-akzent-fg);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);font:700 13px/1 system-ui,sans-serif;box-sizing:border-box}
.kk-karte .kk-k-pin.kk-k-ca{border-style:dashed;opacity:.85}
.kk-karte .kk-k-pin:focus-visible{outline:3px solid #1c1917;outline-offset:2px}
.kk-karte .kk-k-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.kk-karte .leaflet-popup-content{margin:.8em 1em;color:var(--kk-k-popup-fg);font-size:14px;line-height:1.4;max-height:16em;overflow:auto}
.kk-karte .kk-k-p-ort{display:block;color:var(--kk-k-popup-muted);font-size:.9em}
.kk-karte .kk-k-p-hinweis{display:block;color:var(--kk-k-popup-muted);font-size:.8em;font-style:italic}
.kk-karte .kk-k-p-list{list-style:none;margin:.5em 0 0;padding:0}
.kk-karte .kk-k-p-list li{margin:0;padding:.3em 0;border-top:1px solid #e7e5e4}
.kk-karte .kk-k-p-list time{display:block;font-size:.8em;color:var(--kk-k-popup-muted)}
.kk-karte .leaflet-popup-content a{color:var(--kk-k-popup-link);font-weight:600}
.kk-karte .kk-k-p-status{font-size:.75em;padding:0 .35em;border:1px solid currentColor;border-radius:3px;text-transform:uppercase;margin-left:.3em}
.kk-karte .kk-k-p-mehr{display:block;margin-top:.3em;font-size:.85em;color:var(--kk-k-popup-muted)}
@media (prefers-reduced-motion:reduce){.kk-karte .leaflet-fade-anim .leaflet-popup,.kk-karte .leaflet-zoom-anim .leaflet-zoom-animated{transition:none!important}}
</style>
    <?php
});

/* ---------------------------------------------------------------- Admin: Konzerte → Karte */

add_action('admin_menu', function () {
    add_submenu_page('edit.php?post_type=' . KK_POST_TYPE, 'Karte', 'Karte', 'manage_options', 'kk-karte', 'kk_karte_page');
});

/** „47.99, 7.84“ → [47.99, 7.84] oder null */
function kk_parse_coords($text) {
    if (!preg_match('/^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/', (string) $text, $m)) return null;
    $lat = (float) str_replace(',', '.', $m[1]);
    $lon = (float) str_replace(',', '.', $m[2]);
    return abs($lat) <= 90 && abs($lon) <= 180 ? [round($lat, 6), round($lon, 6)] : null;
}

function kk_karte_page() {
    if (!current_user_can('manage_options')) return;
    $s = wp_parse_args((array) get_option('kk_karte', []), kk_karte_defaults());
    $geo = kk_geo_all();
    $places = kk_places();
    uasort($places, function ($a, $b) { return strcoll($a['city'] . $a['venue'], $b['city'] . $b['venue']); });
    $notice = isset($_GET['kk_meldung']) ? sanitize_text_field(wp_unslash($_GET['kk_meldung'])) : '';
    $labels = [
        'hand' => ['von Hand', 'ok'], 'quelle' => ['aus der Quelle', 'ok'], 'suche' => ['gefunden', 'ok'],
        'ort' => ['nur Ortsmitte', 'mittel'], 'fehlt' => ['nicht gefunden', 'schlecht'], '' => ['wird gesucht', 'mittel'],
    ];
    $open = 0;
    foreach ($places as $key => $p) if (!isset($geo[$key]['lat'])) $open++;
    ?>
<div class="wrap kk-admin">
    <h1>Konzertkalender – Karte</h1>
    <?php if ($notice !== '') printf('<div class="notice notice-success is-dismissible" role="status"><p>%s</p></div>', esc_html($notice)); ?>
    <p>Die Karte braucht keinen API-Schlüssel. Auf der Seite: <code>[konzertkalender filter="ja" karte="ja"]</code> (Karte über der Liste)
        oder <code>[konzertkalender karte="nur"]</code> (nur die Karte). Die Karte zeigt immer die Termine der aktuellen Auswahl.</p>

    <h2>Anzeige und Datenschutz</h2>
    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
        <input type="hidden" name="action" value="kk_karte_settings">
        <?php wp_nonce_field('kk_karte_settings'); ?>
        <table class="form-table" role="presentation">
            <tr><th scope="row"><label for="kk-anbieter">Kartenanbieter</label></th>
                <td><input id="kk-anbieter" name="anbieter" class="regular-text" value="<?php echo esc_attr($s['anbieter']); ?>">
                <p class="description">Name im Zustimmungs-Hinweis.</p></td></tr>
            <tr><th scope="row"><label for="kk-tiles">Kachel-Adresse</label></th>
                <td><input id="kk-tiles" name="tiles" class="large-text code" value="<?php echo esc_attr($s['tiles']); ?>">
                <p class="description">Mit <code>{z}</code>, <code>{x}</code>, <code>{y}</code> (optional <code>{s}</code>, <code>{r}</code>). Standard: OpenStreetMap – kostenlos, ohne Schlüssel, für kleine Seiten gedacht.</p></td></tr>
            <tr><th scope="row"><label for="kk-attribution">Quellenangabe</label></th>
                <td><input id="kk-attribution" name="attribution" class="large-text code" value="<?php echo esc_attr($s['attribution']); ?>">
                <p class="description">Pflicht bei OpenStreetMap. Links erlaubt.</p></td></tr>
            <tr><th scope="row"><label for="kk-anbieter-ds">Datenschutz des Anbieters</label></th>
                <td><input id="kk-anbieter-ds" name="anbieter_datenschutz" type="url" class="large-text" value="<?php echo esc_attr($s['anbieter_datenschutz']); ?>"></td></tr>
            <tr><th scope="row"><label for="kk-ds">Eigene Datenschutzerklärung</label></th>
                <td><input id="kk-ds" name="datenschutz" type="url" class="large-text" value="<?php echo esc_attr($s['datenschutz']); ?>" placeholder="<?php echo esc_attr((string) get_privacy_policy_url()); ?>">
                <p class="description">Leer: die Datenschutzseite aus <em>Einstellungen → Datenschutz</em>. Dort den Kartenanbieter erwähnen.</p></td></tr>
            <tr><th scope="row">Zustimmung</th>
                <td><label><input type="checkbox" name="zustimmung" value="1"<?php checked($s['zustimmung'], '1'); ?>> Erst nach Klick auf „Karte laden“ laden (empfohlen)</label>
                <p class="description">Nur abschalten, wenn die Kacheln vom eigenen Server kommen oder ein Consent-Tool die Karte freigibt
                    (per JavaScript <code>kkKarte.zustimmen()</code> oder Ereignis <code>kk:karte-zustimmung</code> auf <code>document</code>).</p></td></tr>
        </table>
        <?php submit_button('Einstellungen speichern'); ?>
    </form>

    <h2>Orte auf der Karte</h2>
    <p>Koordinaten sucht WordPress im Hintergrund bei Nominatim (OpenStreetMap), höchstens einen Ort pro Sekunde.
        Dabei gehen nur Location und Ort hinaus, keine Besucherdaten. Falsche Positionen hier korrigieren
        (Breite, Länge – z. B. aus openstreetmap.org: Rechtsklick → „Adresse anzeigen“); leer lassen = wieder automatisch suchen.</p>
    <?php if (!$places): ?>
        <p>Noch keine kommenden Termine.</p>
    <?php else: ?>
    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
        <input type="hidden" name="action" value="kk_karte_orte">
        <?php wp_nonce_field('kk_karte_orte'); ?>
        <p><?php printf('%d %s, davon %d ohne Position.', count($places), count($places) === 1 ? 'Ort' : 'Orte', $open); ?>
            <?php if ($open) submit_button('Fehlende jetzt suchen', 'secondary', 'kk_suchen', false); ?></p>
        <table class="widefat striped">
            <thead><tr><th scope="col">Location</th><th scope="col">Ort</th><th scope="col">Termine</th><th scope="col">Koordinaten</th><th scope="col">Stand</th></tr></thead>
            <tbody>
            <?php foreach ($places as $key => $p):
                $g = isset($geo[$key]) ? $geo[$key] : null;
                $art = $g ? $g['art'] : '';
                if ($art === 'fehlt' && kk_geo_open($g)) $art = '';
                $coords = $g && isset($g['lat']) ? $g['lat'] . ', ' . $g['lon'] : '';
                $id = 'kk-geo-' . $key;
                ?>
                <tr>
                    <td><label for="<?php echo esc_attr($id); ?>"><?php echo esc_html($p['venue'] !== '' ? $p['venue'] : '–'); ?></label></td>
                    <td><?php echo esc_html(trim($p['city'] . ($p['country'] ? ' (' . $p['country'] . ')' : ''))); ?></td>
                    <td><?php echo (int) $p['count']; ?></td>
                    <td><input id="<?php echo esc_attr($id); ?>" name="kk_geo[<?php echo esc_attr($key); ?>]" class="regular-text code" value="<?php echo esc_attr($coords); ?>" placeholder="47.9959, 7.8522" inputmode="decimal">
                        <?php if ($coords !== '') printf(' <a href="%s" target="_blank" rel="noopener">prüfen<span class="screen-reader-text"> auf openstreetmap.org (neues Fenster)</span></a>', esc_url(sprintf('https://www.openstreetmap.org/?mlat=%1$s&mlon=%2$s#map=17/%1$s/%2$s', $g['lat'], $g['lon'])));
                        ?></td>
                    <td><span class="kk-tag kk-tag-<?php echo esc_attr($labels[$art][1]); ?>"><?php echo esc_html($labels[$art][0]); ?></span></td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
        <?php submit_button('Koordinaten speichern'); ?>
    </form>
    <?php endif; ?>
</div>
<style>
.kk-admin .kk-tag{display:inline-block;padding:.1em .55em;border-radius:999px;font-size:12px;font-weight:600;border:1px solid}
.kk-admin .kk-tag-ok{background:#ecfdf3;color:#05603a;border-color:#a6f4c5}
.kk-admin .kk-tag-mittel{background:#fffaeb;color:#93370d;border-color:#fedf89}
.kk-admin .kk-tag-schlecht{background:#fef3f2;color:#b42318;border-color:#fecdca}
</style>
    <?php
}

add_action('admin_post_kk_karte_settings', function () {
    if (!current_user_can('manage_options')) wp_die('Keine Berechtigung', 403);
    check_admin_referer('kk_karte_settings');
    $in = function ($k) { return isset($_POST[$k]) ? trim((string) wp_unslash($_POST[$k])) : ''; };
    $d = kk_karte_defaults();
    // esc_url_raw würde die Platzhalter {z}/{x}/{y} entfernen – deshalb eigene Prüfung
    $tiles = $in('tiles');
    $ok = preg_match('#^https://[A-Za-z0-9.\-]+(:\d+)?/[A-Za-z0-9._~\-/{}@?&=%]*$#', $tiles)
        && strpos($tiles, '{z}') !== false && strpos($tiles, '{x}') !== false && strpos($tiles, '{y}') !== false;
    if (!$ok) $tiles = $d['tiles'];
    update_option('kk_karte', [
        'anbieter' => sanitize_text_field($in('anbieter')) ?: $d['anbieter'],
        'tiles' => $tiles,
        'attribution' => wp_kses($in('attribution'), ['a' => ['href' => true]]) ?: $d['attribution'],
        'anbieter_datenschutz' => esc_url_raw($in('anbieter_datenschutz')),
        'datenschutz' => esc_url_raw($in('datenschutz')),
        'zustimmung' => empty($_POST['zustimmung']) ? '0' : '1',
    ], false);
    wp_safe_redirect(add_query_arg(['post_type' => KK_POST_TYPE, 'page' => 'kk-karte', 'kk_meldung' => rawurlencode('Einstellungen gespeichert.')], admin_url('edit.php')));
    exit;
});

add_action('admin_post_kk_karte_orte', function () {
    if (!current_user_can('manage_options')) wp_die('Keine Berechtigung', 403);
    check_admin_referer('kk_karte_orte');
    $geo = kk_geo_all();
    $places = kk_places();
    $posted = isset($_POST['kk_geo']) && is_array($_POST['kk_geo']) ? wp_unslash($_POST['kk_geo']) : [];
    $changed = 0;
    $invalid = [];
    foreach ($posted as $key => $text) {
        $key = sanitize_key($key);
        if (!isset($places[$key])) continue;
        $p = $places[$key];
        $g = isset($geo[$key]) ? $geo[$key] : null;
        $text = trim((string) $text);
        $before = $g && isset($g['lat']) ? $g['lat'] . ', ' . $g['lon'] : '';
        if ($text === $before) continue;
        if ($text === '') { unset($geo[$key]); $changed++; continue; } // wieder automatisch suchen
        $c = kk_parse_coords($text);
        if (!$c) { $invalid[] = $p['venue'] !== '' ? $p['venue'] : $p['city']; continue; }
        $geo[$key] = ['venue' => $p['venue'], 'city' => $p['city'], 'country' => $p['country'], 'lat' => $c[0], 'lon' => $c[1], 'art' => 'hand', 't' => time()];
        $changed++;
    }
    kk_geo_save($geo);
    $msg = sprintf('%d %s gespeichert.', $changed, $changed === 1 ? 'Ort' : 'Orte');
    if ($invalid) $msg .= ' Nicht lesbar (Format „47.99, 7.84“): ' . implode(', ', $invalid) . '.';
    if (!empty($_POST['kk_suchen'])) {
        $r = kk_geocode_run();
        $msg .= sprintf(' Suche: %d gefunden, %d nur Ortsmitte, %d nicht gefunden', $r['gefunden'], $r['ungefaehr'], $r['fehlt']);
        $msg .= $r['fehler'] ? ', Nominatim nicht erreichbar – später erneut.' : ($r['offen'] ? sprintf(', %d weitere folgen im Hintergrund.', $r['offen']) : '.');
    } else {
        kk_geo_schedule();
    }
    wp_safe_redirect(add_query_arg(['post_type' => KK_POST_TYPE, 'page' => 'kk-karte', 'kk_meldung' => rawurlencode($msg)], admin_url('edit.php')));
    exit;
});
