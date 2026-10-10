import { Marker } from 'maplibre-gl';
import './style.css';
import { avgRating, lastVisit, store, type Place, type Wish } from './store';
import { CoffeeMap, ratingColor } from './map';
import { searchPlaces, type SearchResult } from './search';
import { KIND_INFO, loadPlaces, nearestPlace, searchKnownPlaces, type KnownPlace } from './place-directory';

/** Rating a coffee you drank, or saving a place to try later. */
type Mode = 'rate' | 'wish';

type View =
  | { kind: 'list' }
  | { kind: 'place'; id: string }
  | { kind: 'wish'; id: string }
  | { kind: 'form'; mode: Mode; placeId?: string; wishId?: string; lng: number; lat: number; name: string; note?: string };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** Tiny DOM builder; text is always set via textContent so user input is never parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (typeof v === 'boolean') v && el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Five stars filled proportionally to the rating (supports halves). */
function starsEl(r: number, cls = '') {
  return h('span', { class: `stars ${cls}`, style: `--c:${ratingColor(r)}`, 'aria-label': `${r.toFixed(1)} out of 5` },
    ...Array.from({ length: 5 }, (_, i) => {
      const s = h('span', { class: 'star', 'aria-hidden': 'true' }, '★');
      s.style.setProperty('--fill', `${Math.max(0, Math.min(1, r - i)) * 100}%`);
      return s;
    }),
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2800);
}

// ---------------------------------------------------------------------------

const panel = $('#panel');
let view: View = { kind: 'list' };
let picking = false;
let pickMode: Mode = 'rate';
let listTab: 'rated' | 'wishes' = 'rated';
let pickMarker: Marker | null = null;

const cmap = new CoffeeMap($('#map'), {
  onPlaceClick: (id) => {
    if (picking) return;
    setView({ kind: 'place', id });
  },
  onMapClick: (lng, lat, name) => {
    if (picking || (view.kind === 'form' && !view.placeId && !view.wishId)) return choosePoint(lng, lat, name ?? '');
    if (view.kind !== 'list' && view.kind !== 'form') setView({ kind: 'list' });
  },
  onWishClick: (id) => {
    if (picking) return;
    setView({ kind: 'wish', id });
  },
});

function setView(v: View) {
  view = v;
  render();
}

function updateStats() {
  const places = store.all();
  const cups = places.reduce((s, p) => s + p.visits.length, 0);
  const avg = cups ? places.reduce((s, p) => s + p.visits.reduce((a, v) => a + v.rating, 0), 0) / cups : 0;
  const wishes = store.wishList().length;
  $('#stats').textContent = (cups
    ? `${places.length} ${places.length === 1 ? 'place' : 'places'} · ${cups} ${cups === 1 ? 'cup' : 'cups'} · avg ★ ${avg.toFixed(1)}`
    : 'No cups rated yet') + (wishes ? ` · ♥ ${wishes}` : '');
}

// --- Picking a location ------------------------------------------------------

function startPicking(mode: Mode = 'rate') {
  picking = true;
  pickMode = mode;
  $('#pick-text').textContent = mode === 'wish' ? 'Tap the place you want to try' : 'Tap the café, restaurant or spot where you were';
  document.body.classList.add('is-picking');
  $('#pick-banner').hidden = false;
  cmap.clouds.setOpacity(0.25);
  setView({ kind: 'list' });
}

function stopPicking() {
  picking = false;
  document.body.classList.remove('is-picking');
  $('#pick-banner').hidden = true;
  cmap.clouds.setOpacity(1);
}

function clearPickMarker() {
  pickMarker?.remove();
  pickMarker = null;
  cmap.setPickPoint(null);
}

/**
 * `snapMetres`: how far a known café may be from the point to count as "this café" (default: about
 * a fingertip on screen). Pass 0 when the location is already exact, e.g. a search result.
 */
function choosePoint(lng: number, lat: number, name: string, snapMetres = Math.max(12, cmap.pxToMetres(28, lat))) {
  const mode: Mode = view.kind === 'form' ? view.mode : pickMode;
  // Snap to a known café or eating place near the point, so the name and the spot are its real ones.
  if (snapMetres > 0) {
    const known = nearestPlace(lng, lat, snapMetres);
    if (known) {
      lng = known.lng;
      lat = known.lat;
      name = known.name;
    }
  }
  // When rating, a tap close to an existing place means "another cup here".
  const near = mode === 'wish' ? undefined : store.all().find((p) => {
    const a = cmap.map.project([p.lng, p.lat]);
    const b = cmap.map.project([lng, lat]);
    return Math.hypot(a.x - b.x, a.y - b.y) < 24;
  });
  stopPicking();
  if (near) {
    clearPickMarker();
    return setView({ kind: 'form', mode: 'rate', placeId: near.id, lng: near.lng, lat: near.lat, name: near.name });
  }
  if (!pickMarker) {
    pickMarker = new Marker({ color: '#3b2418', draggable: true }).setLngLat([lng, lat]).addTo(cmap.map);
    pickMarker.on('drag', () => {
      const p = pickMarker!.getLngLat();
      cmap.setPickPoint({ lng: p.lng, lat: p.lat });
      if (view.kind === 'form') Object.assign(view, { lng: p.lng, lat: p.lat });
    });
  } else {
    pickMarker.setLngLat([lng, lat]);
  }
  cmap.setPickPoint({ lng, lat });
  cmap.clouds.setOpacity(0.55);
  const prevName = view.kind === 'form' && !view.placeId ? (panel.querySelector('#f-name') as HTMLInputElement)?.value : '';
  setView({ kind: 'form', mode, lng, lat, name: name || prevName || '' });
}

function locateMe() {
  if (!navigator.geolocation) return toast('Location is not available on this device');
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { longitude: lng, latitude: lat, accuracy } = pos.coords;
      cmap.flyTo([lng, lat], 17);
      // GPS is off by tens of metres indoors; look for the place you're probably sitting in.
      choosePoint(lng, lat, '', Math.min(80, Math.max(30, accuracy || 0)));
    },
    () => toast("Couldn't get your location"),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
}

// --- Panel views --------------------------------------------------------------

function render() {
  updateStats();
  panel.replaceChildren();
  panel.dataset.view = view.kind;
  $('#fabs').hidden = view.kind === 'form';
  cmap.setKnownPlacesVisible(picking || (view.kind === 'form' && !view.placeId && !view.wishId));
  if (view.kind !== 'form') {
    clearPickMarker();
    if (!picking) cmap.clouds.setOpacity(1);
  }
  if (view.kind === 'list') renderList();
  else if (view.kind === 'place') renderPlace(view.id);
  else if (view.kind === 'wish') renderWish(view.id);
  else renderForm(view);
}

function renderTabs() {
  const tab = (id: typeof listTab, label: string) =>
    h('button', {
      role: 'tab', 'aria-selected': String(listTab === id),
      onclick: () => { listTab = id; render(); },
    }, label);
  return h('div', { class: 'tabs', role: 'tablist' },
    tab('rated', `☕ Rated (${store.all().length})`),
    tab('wishes', `♥ Wish list (${store.wishList().length})`),
  );
}

function renderList() {
  panel.append(renderTabs());
  if (listTab === 'wishes') return renderWishList();
  const places = [...store.all()].sort((a, b) => avgRating(b) - avgRating(a));
  if (!places.length) {
    panel.append(
      h('div', { class: 'empty' },
        h('div', { class: 'empty__art', 'aria-hidden': 'true' }, '☁️☕☁️'),
        h('h2', {}, 'Israel is still under the clouds'),
        h('p', {}, 'Every coffee you rate parts the clouds and raises a building where you drank it. Better coffee, taller tower.'),
        h('button', { class: 'btn btn--primary', onclick: () => startPicking('rate') }, 'Rate your first coffee'),
      ),
    );
    return;
  }
  const list = h('ul', { class: 'place-list' });
  for (const p of places) {
    const r = avgRating(p);
    const lv = lastVisit(p);
    list.append(
      h('li', {},
        h('button', {
          class: 'place-item',
          onclick: () => {
            setView({ kind: 'place', id: p.id });
            cmap.flyTo([p.lng, p.lat]);
          },
        },
          h('span', { class: 'place-item__badge', style: `--c:${ratingColor(r)}` }, r.toFixed(1)),
          h('span', { class: 'place-item__body' },
            h('strong', {}, p.name),
            h('small', {}, `${p.visits.length} ${p.visits.length === 1 ? 'cup' : 'cups'}${lv ? ` · last ${fmtDate(lv.date)}` : ''}`),
          ),
        ),
      ),
    );
  }
  panel.append(
    h('div', { class: 'panel__head' },
      h('h2', { class: 'grow' }, 'My coffee map'),
      h('button', { class: 'btn btn--ghost btn--sm', onclick: () => cmap.showAll() }, 'Show all'),
    ),
    list,
  );
}

function renderWishList() {
  const wishes = [...store.wishList()].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  if (!wishes.length) {
    panel.append(
      h('div', { class: 'empty' },
        h('div', { class: 'empty__art', 'aria-hidden': 'true' }, '♥'),
        h('h2', {}, 'Places you want to try'),
        h('p', {}, 'Heard about a great café? Pin it to your wish list. It stays on the map above the clouds until you go and rate it.'),
        h('button', { class: 'btn btn--wish', onclick: () => startPicking('wish') }, 'Add a place'),
      ),
    );
    return;
  }
  panel.append(
    h('ul', { class: 'place-list' },
      ...wishes.map((w) =>
        h('li', {},
          h('button', {
            class: 'place-item',
            onclick: () => {
              setView({ kind: 'wish', id: w.id });
              cmap.flyTo([w.lng, w.lat]);
            },
          },
            h('span', { class: 'place-item__badge place-item__badge--wish', 'aria-hidden': 'true' }, '♥'),
            h('span', { class: 'place-item__body' },
              h('strong', {}, w.name),
              h('small', {}, w.note ? w.note.slice(0, 60) : `Added ${fmtDate(w.addedAt)}`),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderWish(id: string) {
  const w = store.getWish(id);
  if (!w) return setView({ kind: 'list' });
  panel.append(
    h('div', { class: 'panel__head' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => { listTab = 'wishes'; setView({ kind: 'list' }); } }, '←'),
      h('h2', { class: 'grow' }, w.name),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Edit', title: 'Edit',
        onclick: () => {
          const name = prompt('Place name', w.name)?.trim();
          if (!name) return;
          const note = prompt('Note', w.note);
          store.updateWish(w.id, { name, note: note === null ? w.note : note.trim() });
        },
      }, '✎'),
    ),
    h('div', { class: 'wish-card' },
      h('small', {}, `♥ On your wish list since ${fmtDate(w.addedAt)}`),
      w.note ? h('p', {}, w.note) : null,
    ),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn btn--primary grow',
        onclick: () => setView({ kind: 'form', mode: 'rate', wishId: w.id, lng: w.lng, lat: w.lat, name: w.name }),
      }, '☕ Drank here — rate it'),
      h('button', { class: 'btn btn--ghost', onclick: () => cmap.flyTo([w.lng, w.lat]) }, 'Fly there'),
    ),
    h('button', {
      class: 'btn btn--danger btn--sm',
      onclick: () => {
        if (!confirm(`Remove “${w.name}” from your wish list?`)) return;
        store.deleteWish(w.id);
        listTab = 'wishes';
        setView({ kind: 'list' });
      },
    }, 'Remove from wish list'),
  );
}

function renderPlace(id: string) {
  const p = store.get(id);
  if (!p) return setView({ kind: 'list' });
  const r = avgRating(p);
  const visits = [...p.visits].sort((a, b) => b.date.localeCompare(a.date));

  panel.append(
    h('div', { class: 'panel__head' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => setView({ kind: 'list' }) }, '←'),
      h('h2', { class: 'grow' }, p.name),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Rename', title: 'Rename',
        onclick: () => {
          const name = prompt('Place name', p.name)?.trim();
          if (name) store.renamePlace(p.id, name);
        },
      }, '✎'),
    ),
    h('div', { class: 'score', style: `--c:${ratingColor(r)}` },
      h('span', { class: 'score__num' }, r.toFixed(1)),
      starsEl(r, 'score__stars'),
      h('span', { class: 'score__meta' }, `${p.visits.length} ${p.visits.length === 1 ? 'cup' : 'cups'} here`),
    ),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary', onclick: () => setView({ kind: 'form', mode: 'rate', placeId: p.id, lng: p.lng, lat: p.lat, name: p.name }) }, '＋ Another cup'),
      h('button', { class: 'btn btn--ghost', onclick: () => cmap.flyTo([p.lng, p.lat]) }, 'Fly there'),
    ),
    h('ul', { class: 'visits' },
      ...visits.map((v) =>
        h('li', { class: 'visit' },
          h('div', { class: 'visit__top' },
            starsEl(v.rating),
            h('time', { datetime: v.date }, fmtDate(v.date)),
            h('button', {
              class: 'icon-btn icon-btn--sm', 'aria-label': 'Delete this cup', title: 'Delete this cup',
              onclick: () => {
                if (!confirm('Delete this rating?')) return;
                const last = p.visits.length === 1;
                store.deleteVisit(p.id, v.id);
                if (last) setView({ kind: 'list' });
              },
            }, '🗑'),
          ),
          v.comment ? h('p', { class: 'visit__comment' }, v.comment) : null,
        ),
      ),
    ),
    h('button', {
      class: 'btn btn--danger btn--sm',
      onclick: () => {
        if (!confirm(`Delete “${p.name}” and all its ratings?`)) return;
        store.deletePlace(p.id);
        setView({ kind: 'list' });
      },
    }, 'Delete place'),
  );
}

function starInput(initial: number, onChange: (v: number) => void) {
  let value = initial;
  const wrap = h('div', { class: 'star-input', role: 'slider', tabindex: '0', 'aria-label': 'Rating', 'aria-valuemin': '0.5', 'aria-valuemax': '5' });
  const label = h('span', { class: 'star-input__label' });
  const stars = Array.from({ length: 5 }, (_, i) => {
    const s = h('span', { class: 'star', 'data-i': String(i) }, '★');
    s.addEventListener('click', (e) => {
      const rect = s.getBoundingClientRect();
      const half = (e as MouseEvent).clientX - rect.left < rect.width / 2;
      set(i + (half ? 0.5 : 1));
    });
    return s;
  });
  const update = () => {
    stars.forEach((s, i) => {
      const fill = Math.max(0, Math.min(1, value - i));
      s.style.setProperty('--fill', `${fill * 100}%`);
    });
    wrap.style.setProperty('--c', ratingColor(value || 1));
    wrap.setAttribute('aria-valuenow', String(value));
    label.textContent = value ? `${value.toFixed(1)} — ${['', 'Undrinkable', 'Meh', 'Decent', 'Great', 'Perfect'][Math.round(value)] || ''}` : 'Tap a star';
  };
  const set = (v: number) => {
    value = Math.max(0.5, Math.min(5, v));
    update();
    onChange(value);
  };
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set(value + 0.5); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set(value - 0.5); e.preventDefault(); }
  });
  wrap.append(h('div', { class: 'star-input__stars' }, ...stars), label);
  update();
  return wrap;
}

function renderForm(v: Extract<View, { kind: 'form' }>) {
  const existing = v.placeId ? store.get(v.placeId) : undefined;
  const fromWish: Wish | undefined = v.wishId ? store.getWish(v.wishId) : undefined;
  const isNew = !existing && !fromWish;
  if (v.mode === 'wish') return renderWishForm(v);
  let rating = 0;

  const name = h('input', { id: 'f-name', type: 'text', required: true, maxlength: '80', placeholder: 'e.g. Cafe Xoho', value: v.name }) as HTMLInputElement;
  const comment = h('textarea', { id: 'f-comment', rows: '3', maxlength: '1000', placeholder: 'Flat white, a bit bitter, great croissant…' }) as HTMLTextAreaElement;
  const date = h('input', { id: 'f-date', type: 'date', value: new Date().toISOString().slice(0, 10) }) as HTMLInputElement;
  const error = h('p', { class: 'form__error', hidden: true });

  const cancel = () =>
    setView(existing ? { kind: 'place', id: existing.id } : fromWish ? { kind: 'wish', id: fromWish.id } : { kind: 'list' });

  const form = h('form', {
    class: 'form',
    onsubmit: (e) => {
      e.preventDefault();
      const nm = name.value.trim();
      if (!nm) return showErr('Give the place a name');
      if (!rating) return showErr('How was it? Tap the stars');
      const d = date.value ? new Date(`${date.value}T${new Date().toTimeString().slice(0, 8)}`) : new Date();
      const visit = { rating, comment: comment.value.trim(), date: (isNaN(+d) ? new Date() : d).toISOString() };
      let id: string;
      if (existing) {
        store.addVisit(existing.id, visit);
        id = existing.id;
        cmap.bump(id);
      } else {
        const cur = view.kind === 'form' ? view : v;
        id = store.addPlace(nm, cur.lng, cur.lat, visit).id;
        // Tried it - it graduates from the wish list.
        if (fromWish) store.deleteWish(fromWish.id);
      }
      clearPickMarker();
      setView({ kind: 'place', id });
      const p = store.get(id)!;
      cmap.flyTo([p.lng, p.lat]);
      toast(existing ? 'Cup logged ☕' : 'The clouds part… ☀️');
    },
  },
    h('div', { class: 'panel__head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Cancel', onclick: cancel }, '✕'),
      h('h2', { class: 'grow' }, existing ? `Another cup at ${existing.name}` : 'Rate this coffee'),
    ),
    isNew ? modeTabs(v) : null,
    existing ? null : h('label', { for: 'f-name' }, 'Place', name),
    isNew ? h('p', { class: 'hint' }, 'Drag the pin or tap the map to adjust the spot.') : null,
    h('label', {}, 'How tasty was it?', starInput(0, (r) => { rating = r; error.hidden = true; })),
    h('label', { for: 'f-comment' }, 'Notes', comment),
    h('label', { for: 'f-date' }, 'Date', date),
    error,
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'btn btn--primary grow' }, existing ? 'Log cup' : 'Save & reveal'),
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: cancel }, 'Cancel'),
    ),
  );
  function showErr(msg: string) {
    error.textContent = msg;
    error.hidden = false;
  }
  panel.append(form);
  if (!existing && !v.name) setTimeout(() => name.focus(), 50);
}

/** Rate / Wish switch shown when adding a brand-new place. */
function modeTabs(v: Extract<View, { kind: 'form' }>) {
  const sw = (mode: Mode, label: string) =>
    h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(v.mode === mode),
      onclick: () => {
        if (v.mode === mode) return;
        const nm = (panel.querySelector('#f-name') as HTMLInputElement | null)?.value ?? v.name;
        const cur = view.kind === 'form' ? view : v;
        setView({ ...cur, mode, name: nm });
      },
    }, label);
  return h('div', { class: 'tabs', role: 'tablist' }, sw('rate', '☕ I drank here'), sw('wish', '♥ Want to try'));
}

function renderWishForm(v: Extract<View, { kind: 'form' }>) {
  const name = h('input', { id: 'f-name', type: 'text', required: true, maxlength: '80', placeholder: 'e.g. Cafe Xoho', value: v.name }) as HTMLInputElement;
  const note = h('textarea', { id: 'f-note', rows: '3', maxlength: '1000', placeholder: 'Who recommended it? What to order?' }) as HTMLTextAreaElement;
  note.value = v.note ?? '';
  const error = h('p', { class: 'form__error', hidden: true });
  const cancel = () => { clearPickMarker(); setView({ kind: 'list' }); };
  panel.append(
    h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const nm = name.value.trim();
        if (!nm) {
          error.textContent = 'Give the place a name';
          error.hidden = false;
          return;
        }
        const cur = view.kind === 'form' ? view : v;
        const w = store.addWish(nm, cur.lng, cur.lat, note.value.trim());
        clearPickMarker();
        setView({ kind: 'wish', id: w.id });
        toast('Pinned to your wish list ♥');
      },
    },
      h('div', { class: 'panel__head' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Cancel', onclick: cancel }, '✕'),
        h('h2', { class: 'grow' }, 'Add to wish list'),
      ),
      modeTabs(v),
      h('label', { for: 'f-name' }, 'Place', name),
      h('p', { class: 'hint' }, 'Drag the pin or tap the map to adjust the spot.'),
      h('label', { for: 'f-note' }, 'Note', note),
      error,
      h('div', { class: 'row' },
        h('button', { type: 'submit', class: 'btn btn--wish grow' }, '♥ Save to wish list'),
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: cancel }, 'Cancel'),
      ),
    ),
  );
  if (!v.name) setTimeout(() => name.focus(), 50);
}

// --- Search -----------------------------------------------------------------

const searchInput = $<HTMLInputElement>('#search-input');
const resultsEl = $('#search-results');
let lastResults: SearchResult[] = [];

/** "350 m" / "12 km" from the middle of the map, to tell branches with the same name apart. */
function distanceLabel(lng: number, lat: number) {
  const c = cmap.map.getCenter();
  const m = Math.hypot((lng - c.lng) * 111_320 * Math.cos((lat * Math.PI) / 180), (lat - c.lat) * 110_540);
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${m < 10_000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)} km`;
}

$('#search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q.length < 2) return;
  resultsEl.hidden = false;
  resultsEl.replaceChildren(h('li', { class: 'muted' }, 'Searching…'));
  // Cafés and eating places from the bundled directory (exact names and spots) first, then streets/addresses.
  const [known, places] = await Promise.all([
    searchKnownPlaces(q, cmap.map.getCenter()),
    searchPlaces(q).catch(() => null),
  ]);
  lastResults = places ?? [];
  const pick = (lng: number, lat: number, name: string) => {
    resultsEl.hidden = true;
    searchInput.value = name;
    cmap.flyTo([lng, lat], 17.5);
    choosePoint(lng, lat, name, 0);
  };
  const items: HTMLElement[] = [
    ...known.map((c: KnownPlace) =>
      h('li', {},
        h('button', { type: 'button', onclick: () => pick(c.lng, c.lat, c.name) },
          h('strong', {}, `${KIND_INFO[c.kind].icon} ${c.name}`),
          h('small', {}, [c.address || KIND_INFO[c.kind].label, distanceLabel(c.lng, c.lat)].join(' · '))),
      ),
    ),
    ...lastResults
      // Skip address hits that are just the same place again.
      .filter((r) => !known.some((c) => Math.abs(c.lat - r.lat) < 0.0003 && Math.abs(c.lng - r.lng) < 0.0003))
      .map((r) =>
        h('li', {},
          h('button', { type: 'button', onclick: () => pick(r.lng, r.lat, r.name) },
            h('strong', {}, r.name), h('small', {}, r.detail)),
        ),
      ),
  ];
  if (!items.length) {
    items.push(h('li', { class: 'muted' }, places === null ? 'Search failed — check your connection' : 'Nothing found in Israel'));
  } else if (places === null) {
    items.push(h('li', { class: 'muted' }, 'Street search is offline; showing known places only'));
  }
  resultsEl.replaceChildren(...items);
});
// Warm the place directory so the first tap/search is instant.
loadPlaces();
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#search')) resultsEl.hidden = true;
  if (!(e.target as HTMLElement).closest('.menu')) $('#menu').hidden = true;
});

// --- Menu: export / import ----------------------------------------------------

$('#menu-btn').addEventListener('click', () => ($('#menu').hidden = !$('#menu').hidden));
$('#menu').addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest('button')?.dataset.action;
  $('#menu').hidden = true;
  if (action === 'export') {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `coffemap-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else if (action === 'import') {
    $('#import-file').click();
  } else if (action === 'reset-view') {
    cmap.showAll();
  }
});
$<HTMLInputElement>('#import-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const n = store.importJSON(await file.text());
    toast(`Imported ${n.places} ${n.places === 1 ? 'place' : 'places'}${n.wishes ? ` and ${n.wishes} wish${n.wishes === 1 ? '' : 'es'}` : ''}`);
  } catch (err) {
    toast(`Import failed: ${(err as Error).message}`);
  }
});

// --- Wiring -------------------------------------------------------------------

$('#rate-btn').addEventListener('click', () => startPicking('rate'));
$('#wish-btn').addEventListener('click', () => startPicking('wish'));
$('#pick-cancel').addEventListener('click', () => {
  stopPicking();
  render();
});
$('#locate-btn').addEventListener('click', locateMe);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (picking) {
    stopPicking();
    render();
  } else if (view.kind !== 'list') setView({ kind: 'list' });
});

store.subscribe((places: Place[]) => {
  cmap.setPlaces(places);
  cmap.setWishes(store.wishList());
  render();
});

cmap.setPlaces(store.all(), { stagger: true });
cmap.setWishes(store.wishList());
render();
