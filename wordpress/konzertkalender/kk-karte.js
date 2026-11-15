/**
 * Konzertkalender – Karte. Leaflet und die Kartenkacheln werden erst geladen, wenn jemand
 * „Karte laden“ klickt oder das früher für diese Website erlaubt hat (localStorage, nur ein Merker,
 * kein Cookie). Consent-Tools können die Karte freigeben: kkKarte.zustimmen() oder das Ereignis
 * „kk:karte-zustimmung“ auf document; kkKarte.widerrufen() nimmt die gemerkte Zustimmung zurück.
 */
(() => {
  const KEY = 'kk-karte-zustimmung';
  const MAX_EVENTS = 8;
  const cfg = window.kkKarteConfig || {};
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const remembered = () => {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  };
  const remember = (on) => {
    try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch (e) { /* privates Fenster */ }
  };

  let leaflet = null;
  const loadLeaflet = () => {
    if (window.L) return Promise.resolve(window.L);
    if (leaflet) return leaflet;
    leaflet = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = cfg.leafletCss;
      document.head.append(css);
      const js = document.createElement('script');
      js.src = cfg.leafletJs;
      js.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet fehlt')));
      js.onerror = () => { leaflet = null; js.remove(); reject(new Error('Leaflet nicht geladen')); };
      document.head.append(js);
    });
    return leaflet;
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };

  const concerts = (n) => `${n} ${n === 1 ? 'Konzert' : 'Konzerte'}`;

  /** Inhalt eines Popups – alles über textContent, nichts aus den Daten als HTML. */
  const popup = (place) => {
    const box = el('div', 'kk-k-popup');
    box.append(el('strong', '', place.n));
    if (place.c) box.append(el('span', 'kk-k-p-ort', place.c));
    if (place.ca) box.append(el('span', 'kk-k-p-hinweis', 'Lage ungefähr (Ortsmitte)'));
    const list = el('ul', 'kk-k-p-list');
    place.ev.slice(0, MAX_EVENTS).forEach((e) => {
      const li = el('li');
      const time = el('time', '', e.w);
      time.dateTime = e.d;
      li.append(time);
      if (e.u) {
        const a = el('a', '', e.a);
        a.href = e.u;
        a.target = '_blank';
        a.rel = 'noopener nofollow';
        a.title = 'Infos & Tickets beim Veranstalter';
        li.append(a);
      } else {
        li.append(el('span', '', e.a));
      }
      if (e.s) li.append(el('span', 'kk-k-p-status', e.s));
      list.append(li);
    });
    box.append(list);
    if (place.ev.length > MAX_EVENTS) box.append(el('span', 'kk-k-p-mehr', `+ ${place.ev.length - MAX_EVENTS} weitere in der Liste`));
    return box;
  };

  const draw = (L, area, places) => {
    const map = L.map(area, {
      scrollWheelZoom: false, // sonst bleibt man beim Scrollen der Seite in der Karte hängen
      zoomAnimation: !reducedMotion,
      fadeAnimation: !reducedMotion,
      markerZoomAnimation: !reducedMotion,
    });
    map.attributionControl.setPrefix(false);
    L.tileLayer(cfg.tiles, { maxZoom: 19, attribution: cfg.attribution }).addTo(map);
    // Mausrad erst, wenn die Karte angeklickt oder per Tastatur fokussiert ist
    map.on('focus click', () => map.scrollWheelZoom.enable());
    map.on('blur', () => map.scrollWheelZoom.disable());

    const markers = places.map((p) => {
      const label = `${p.n}${p.c ? `, ${p.c}` : ''}: ${concerts(p.ev.length)}`;
      const icon = L.divIcon({
        className: '',
        html: `<span class="kk-k-pin${p.ca ? ' kk-k-ca' : ''}"><span aria-hidden="true">${p.ev.length}</span></span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        popupAnchor: [0, -14],
      });
      const marker = L.marker([p.lat, p.lon], { icon, keyboard: true, title: label, alt: label, riseOnHover: true });
      marker.bindPopup(() => popup(p), { maxWidth: 300, autoPanPadding: [20, 20] });
      marker.on('add', () => {
        const node = marker.getElement();
        if (!node) return;
        node.setAttribute('aria-label', label);
        node.setAttribute('role', 'button');
      });
      return marker.addTo(map);
    });

    const group = L.featureGroup(markers);
    if (markers.length === 1) map.setView(markers[0].getLatLng(), 14);
    else map.fitBounds(group.getBounds(), { padding: [30, 30], maxZoom: 14, animate: false });
    return map;
  };

  const boxes = [];

  const setup = (box) => {
    const dataNode = box.querySelector('.kk-k-daten');
    const area = box.querySelector('.kk-k-flaeche');
    if (!dataNode || !area) return;
    let places = [];
    try { places = JSON.parse(dataNode.textContent || '[]'); } catch (e) { return; }
    if (!places.length) return;

    const consent = box.querySelector('.kk-k-zustimmung');
    const button = box.querySelector('.kk-k-laden');
    const keep = box.querySelector('.kk-k-merken input');
    const status = box.querySelector('.kk-k-status');
    const foot = box.querySelector('.kk-k-fuss');
    const info = box.querySelector('.kk-k-info');
    const revoke = box.querySelector('.kk-k-widerrufen');
    let state = 'wartet';

    const show = async (focus) => {
      if (state !== 'wartet') return;
      state = 'laedt';
      if (button) button.disabled = true;
      if (status) status.textContent = 'Karte wird geladen …';
      try {
        const L = await loadLeaflet();
        area.hidden = false;
        const map = draw(L, area, places);
        if (consent) consent.hidden = true;
        if (foot) foot.hidden = false;
        if (info) info.textContent = `${places.length} ${places.length === 1 ? 'Ort' : 'Orte'} · Punkt anklicken oder mit Tab und Enter auswählen`;
        if (revoke) revoke.hidden = !remembered();
        map.invalidateSize();
        if (focus) area.focus();
        state = 'geladen';
      } catch (e) {
        area.hidden = true;
        state = 'wartet';
        if (button) button.disabled = false;
        if (status) status.textContent = 'Die Karte konnte nicht geladen werden. Bitte später noch einmal versuchen – die Termine stehen in der Liste.';
      }
    };

    if (button) {
      button.addEventListener('click', () => {
        if (keep && keep.checked) remember(true);
        show(true);
      });
    }
    if (revoke) revoke.addEventListener('click', () => window.kkKarte.widerrufen());
    boxes.push(show);
    if (!cfg.zustimmung || remembered()) show(false);
  };

  window.kkKarte = {
    /** z. B. aus einem Consent-Tool: Karte jetzt laden, optional für später merken */
    zustimmen: (merken = true) => {
      if (merken) remember(true);
      boxes.forEach((show) => show(false));
    },
    /** gemerkte Zustimmung löschen; die Seite lädt neu, damit keine Kacheln mehr nachgeladen werden */
    widerrufen: () => {
      remember(false);
      window.location.reload();
    },
  };

  document.addEventListener('kk:karte-zustimmung', (e) => window.kkKarte.zustimmen(!(e.detail && e.detail.merken === false)));

  const start = () => document.querySelectorAll('.kk-karte').forEach(setup);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
