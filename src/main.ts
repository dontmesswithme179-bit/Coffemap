import { Marker } from 'maplibre-gl';
import './style.css';
import { avgRating, lastVisit, store, type Place } from './store';
import { CoffeeMap, ratingColor } from './map';
import { searchPlaces, type SearchResult } from './search';

type View =
  | { kind: 'list' }
  | { kind: 'place'; id: string }
  | { kind: 'form'; placeId?: string; lng: number; lat: number; name: string };

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
let pickMarker: Marker | null = null;

const cmap = new CoffeeMap($('#map'), {
  onPlaceClick: (id) => {
    if (picking) return;
    setView({ kind: 'place', id });
  },
  onMapClick: (lng, lat, name) => {
    if (picking || view.kind === 'form') return choosePoint(lng, lat, name ?? '');
    if (view.kind !== 'list') setView({ kind: 'list' });
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
  $('#stats').textContent = cups
    ? `${places.length} ${places.length === 1 ? 'place' : 'places'} · ${cups} ${cups === 1 ? 'cup' : 'cups'} · avg ★ ${avg.toFixed(1)}`
    : 'No cups rated yet';
}

// --- Picking a location ------------------------------------------------------

function startPicking() {
  picking = true;
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

function choosePoint(lng: number, lat: number, name: string) {
  // A tap close to an existing place means "another cup here".
  const near = store.all().find((p) => {
    const a = cmap.map.project([p.lng, p.lat]);
    const b = cmap.map.project([lng, lat]);
    return Math.hypot(a.x - b.x, a.y - b.y) < 24;
  });
  stopPicking();
  if (near) {
    clearPickMarker();
    return setView({ kind: 'form', placeId: near.id, lng: near.lng, lat: near.lat, name: near.name });
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
  setView({ kind: 'form', lng, lat, name: name || prevName || '' });
}

function locateMe() {
  if (!navigator.geolocation) return toast('Location is not available on this device');
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { longitude: lng, latitude: lat } = pos.coords;
      cmap.flyTo([lng, lat], 17);
      choosePoint(lng, lat, '');
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
  $('#rate-btn').hidden = view.kind === 'form';
  if (view.kind !== 'form') {
    clearPickMarker();
    if (!picking) cmap.clouds.setOpacity(1);
  }
  if (view.kind === 'list') renderList();
  else if (view.kind === 'place') renderPlace(view.id);
  else renderForm(view);
}

function renderList() {
  const places = [...store.all()].sort((a, b) => avgRating(b) - avgRating(a));
  if (!places.length) {
    panel.append(
      h('div', { class: 'empty' },
        h('div', { class: 'empty__art', 'aria-hidden': 'true' }, '☁️☕☁️'),
        h('h2', {}, 'Israel is still under the clouds'),
        h('p', {}, 'Every coffee you rate parts the clouds and raises a building where you drank it. Better coffee, taller tower.'),
        h('button', { class: 'btn btn--primary', onclick: startPicking }, 'Rate your first coffee'),
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
      h('button', { class: 'btn btn--primary', onclick: () => setView({ kind: 'form', placeId: p.id, lng: p.lng, lat: p.lat, name: p.name }) }, '＋ Another cup'),
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
  let rating = 0;

  const name = h('input', { id: 'f-name', type: 'text', required: true, maxlength: '80', placeholder: 'e.g. Cafe Xoho', value: v.name }) as HTMLInputElement;
  const comment = h('textarea', { id: 'f-comment', rows: '3', maxlength: '1000', placeholder: 'Flat white, a bit bitter, great croissant…' }) as HTMLTextAreaElement;
  const date = h('input', { id: 'f-date', type: 'date', value: new Date().toISOString().slice(0, 10) }) as HTMLInputElement;
  const error = h('p', { class: 'form__error', hidden: true });

  const cancel = () => setView(existing ? { kind: 'place', id: existing.id } : { kind: 'list' });

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
    existing ? null : h('label', { for: 'f-name' }, 'Place', name),
    existing ? null : h('p', { class: 'hint' }, 'Drag the pin or tap the map to adjust the spot.'),
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

// --- Search -----------------------------------------------------------------

const searchInput = $<HTMLInputElement>('#search-input');
const resultsEl = $('#search-results');
let lastResults: SearchResult[] = [];

$('#search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q.length < 2) return;
  resultsEl.hidden = false;
  resultsEl.replaceChildren(h('li', { class: 'muted' }, 'Searching…'));
  try {
    lastResults = await searchPlaces(q);
  } catch {
    resultsEl.replaceChildren(h('li', { class: 'muted' }, 'Search failed — check your connection'));
    return;
  }
  resultsEl.replaceChildren(
    ...(lastResults.length
      ? lastResults.map((r) =>
          h('li', {},
            h('button', {
              type: 'button',
              onclick: () => {
                resultsEl.hidden = true;
                searchInput.value = r.name;
                cmap.flyTo([r.lng, r.lat], 17);
                choosePoint(r.lng, r.lat, r.name);
              },
            }, h('strong', {}, r.name), h('small', {}, r.detail)),
          ),
        )
      : [h('li', { class: 'muted' }, 'Nothing found in Israel')]),
  );
});
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
    toast(`Imported ${n} ${n === 1 ? 'place' : 'places'}`);
  } catch (err) {
    toast(`Import failed: ${(err as Error).message}`);
  }
});

// --- Wiring -------------------------------------------------------------------

$('#rate-btn').addEventListener('click', startPicking);
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
  render();
});

cmap.setPlaces(store.all(), { stagger: true });
render();
