/**
 * Map-search page (phase b): draw a circle on a map, list what the platform
 * sells there. No analysis and no verdicts here — phase (c) adds those on top
 * of this list.
 *
 * This file is DOM + Leaflet glue only; every decision that can be pure lives
 * in `./controller.ts`, `./circlesel.ts` and `./rangecal.ts`. Search results
 * are
 * attacker-adjacent content, so every rendered string goes through
 * textContent/createElement — never innerHTML — and card URLs pass the
 * http(s)-only gate before they become an href or src.
 *
 * House rule: `PLATFORM_ID` below is the only platform string in this page.
 * Everything else — building the search URL (in the worker), parsing the
 * results, the platform's display name and homepage — comes through the
 * adapter interface.
 */
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { browser } from 'wxt/browser';
import { createSettingsStore } from '../../background/settings';
import {
  MAX_RADIUS_KM,
  circleToQuery,
  type SearchCategory,
  type SearchCircle,
} from '../../lib/areasearch';
import {
  SUPPORTED_LANGUAGES,
  activateLanguage,
  activeLanguageTag,
  applyTranslations,
  selectPlural,
  t,
  type MessageKey,
} from '../../lib/i18n';
import type {
  SearchAreaFetchMessage,
  SearchAreaFetchResponse,
  SearchFocusListingMessage,
  SearchFocusListingResponse,
} from '../../lib/messages';
import { PRESENCE_PORT_NAME, createPresenceClient } from '../../lib/presence';
import { adapterById } from '../../lib/sites/registry';
import type { SearchResultCard } from '../../lib/sites/types';
import { addMonths, clickDay, inRange, monthMatrix, nightsBetween, type DateRange } from './rangecal';
import { formatRadius, partitionByRadius, radiusKmBetween } from './circlesel';
import {
  DEFAULT_SORT,
  OCCUPANCY_BOUNDS,
  defaultStayDates,
  explainQueryRefusal,
  findByKey,
  httpUrl,
  outsideAreaLine,
  readStayDates,
  resultsStatus,
  reviewLine,
  selectionKey,
  sortCards,
  type SortMode,
} from './controller';

const PLATFORM_ID = 'booking';

/**
 * This page's announcement to the worker (`lib/presence.ts`).
 *
 * A listing check publishes its verdict onto THIS tab, seconds after the
 * click, and must not do so if the page that asked is gone — navigated away,
 * or reloaded into a result list that no longer contains what was asked
 * about. The worker used to establish that by reading this tab's URL, which
 * cost the `tabs` permission and could not tell a reload from standing still.
 * A port answers both, for nothing.
 *
 * Connected at load rather than lazily (the content script's rule): this page
 * exists to talk to the worker, and the guard must already be armed by the
 * time the first check is clicked, not racing it.
 */
const presence = createPresenceClient(() => browser.runtime.connect({ name: PRESENCE_PORT_NAME }));
presence.ensure();

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const datesPopover = byId<HTMLDetailsElement>('dates-popover');
const datesSummary = byId<HTMLElement>('dates-summary');
const calPrevButton = byId<HTMLButtonElement>('cal-prev');
const calNextButton = byId<HTMLButtonElement>('cal-next');
const calMonthEl = byId<HTMLSpanElement>('cal-month');
const calWeekdaysEl = byId<HTMLDivElement>('cal-weekdays');
const calGridEl = byId<HTMLDivElement>('cal-grid');
const calHintEl = byId<HTMLParagraphElement>('cal-hint');
const calClearButton = byId<HTMLButtonElement>('cal-clear');
const typePopover = byId<HTMLDetailsElement>('type-popover');
const typeSummary = byId<HTMLElement>('type-summary');
const adultsInput = byId<HTMLInputElement>('adults');
const roomsInput = byId<HTMLInputElement>('rooms');
const childrenInput = byId<HTMLInputElement>('children');
const drawButton = byId<HTMLButtonElement>('draw');
const searchButton = byId<HTMLButtonElement>('search');
const statusEl = byId<HTMLParagraphElement>('status');
const resultsList = byId<HTMLUListElement>('results');
const mapEl = byId<HTMLDivElement>('map');
const languageSelect = byId<HTMLSelectElement>('language');

// --- form defaults, from one source of truth ------------------------------

for (const [input, bounds] of [
  [adultsInput, OCCUPANCY_BOUNDS.adults],
  [roomsInput, OCCUPANCY_BOUNDS.rooms],
  [childrenInput, OCCUPANCY_BOUNDS.children],
] as const) {
  input.min = String(bounds.min);
  input.max = String(bounds.max);
}

// --- stay dates: range-calendar popover -----------------------------------

/** The selected stay. `{}` is a legitimate undated search, not a gap. */
let stay: DateRange = defaultStayDates(new Date());
/** The month the calendar shows — navigation state, not selection state. */
let visibleMonth = monthOf(stay.checkin ?? todayIso());

function monthOf(iso: string): { year: number; month0: number } {
  return { year: Number(iso.slice(0, 4)), month0: Number(iso.slice(5, 7)) - 1 };
}

/** Today in the user's local calendar — the same ISO-building approach controller.ts uses. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * "13 Sep" in the active language. The ISO string is split by hand into a
 * LOCAL Date — `new Date('2026-09-13')` would parse as UTC midnight, and
 * formatting that locally shifts the day west of Greenwich.
 */
function formatDay(iso: string): string {
  const date = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return new Intl.DateTimeFormat(activeLanguageTag(), { day: 'numeric', month: 'short' }).format(date);
}

/** The summary is the control's whole face; the hint guides the next click. */
function updateDatesSummary(): void {
  if (stay.checkin !== undefined && stay.checkout !== undefined) {
    const nights = nightsBetween(stay.checkin, stay.checkout);
    const nightsText =
      nights === 1
        ? t('search.dates.nightsOne')
        : t(
            selectPlural(nights, {
              one: 'search.dates.nightsOne',
              few: 'search.dates.nightsFew',
              many: 'search.dates.nightsMany',
            }),
            { count: nights },
          );
    datesSummary.textContent = `${formatDay(stay.checkin)} → ${formatDay(stay.checkout)} · ${nightsText}`;
  } else {
    datesSummary.textContent = t('search.dates.choose');
  }
  calHintEl.textContent =
    stay.checkin !== undefined && stay.checkout === undefined
      ? t('search.dates.hintEnd')
      : t('search.dates.hintStart');
}

function renderCalendar(): void {
  const tag = activeLanguageTag();
  calMonthEl.textContent = new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric' }).format(
    new Date(visibleMonth.year, visibleMonth.month0, 1),
  );
  // Weekday header, Monday-first to match monthMatrix. 2024-01-01 was a
  // Monday, and formatting it in UTC keeps it one in every timezone.
  const weekdayFormat = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' });
  calWeekdaysEl.replaceChildren(
    ...Array.from({ length: 7 }, (_, i) => {
      const cell = document.createElement('span');
      cell.textContent = weekdayFormat.format(new Date(Date.UTC(2024, 0, 1 + i)));
      return cell;
    }),
  );
  const today = todayIso();
  // No paging into months that are entirely in the unbookable past.
  const current = monthOf(today);
  calPrevButton.disabled =
    visibleMonth.year < current.year ||
    (visibleMonth.year === current.year && visibleMonth.month0 <= current.month0);
  calGridEl.replaceChildren();
  for (const week of monthMatrix(visibleMonth.year, visibleMonth.month0)) {
    for (const iso of week) {
      if (iso === null) {
        // Empty <span> padding keeps the grid columns aligned.
        calGridEl.append(document.createElement('span'));
        continue;
      }
      const dayButton = document.createElement('button');
      dayButton.type = 'button';
      dayButton.className = 'day';
      dayButton.dataset.iso = iso;
      dayButton.textContent = String(Number(iso.slice(8, 10)));
      dayButton.disabled = iso < today; // the past is not bookable
      if (iso === stay.checkin || iso === stay.checkout) dayButton.classList.add('edge');
      else if (inRange(iso, stay)) dayButton.classList.add('in-range');
      calGridEl.append(dayButton);
    }
  }
  updateDatesSummary();
}

calGridEl.addEventListener('click', (event) => {
  const dayButton = (event.target as HTMLElement).closest<HTMLButtonElement>('button.day');
  if (dayButton === null || dayButton.dataset.iso === undefined) return;
  const iso = dayButton.dataset.iso;
  touched.add('dates');
  stay = clickDay(stay, iso);
  const completed = stay.checkin !== undefined && stay.checkout !== undefined;
  // A completed range closes the popover — the summary now says it all. A
  // started one keeps it open for the second click.
  if (completed) datesPopover.open = false;
  renderCalendar();
  // Only a completed range is a preference worth storing. A half-picked one
  // is mid-edit: persisting it would write "no dates" (see `storedStay`) over
  // the stay the user still has, so it writes nothing at all and the second
  // click of the pair stores the full stay.
  if (completed) {
    rememberStay();
    persistFilters();
  }
  // replaceChildren() destroyed the button that held keyboard focus; put
  // focus back where the user was (the same day, or the summary when the
  // popover just closed) so Enter-Enter selects a range without re-tabbing.
  if (completed) {
    datesSummary.focus();
  } else {
    calGridEl.querySelector<HTMLButtonElement>(`button.day[data-iso="${iso}"]`)?.focus();
  }
});

calPrevButton.addEventListener('click', () => {
  visibleMonth = addMonths(visibleMonth.year, visibleMonth.month0, -1);
  renderCalendar();
});
calNextButton.addEventListener('click', () => {
  visibleMonth = addMonths(visibleMonth.year, visibleMonth.month0, 1);
  renderCalendar();
});
calClearButton.addEventListener('click', () => {
  touched.add('dates');
  stay = {};
  datesPopover.open = false;
  renderCalendar();
  // The ONE gesture that means "deliberately undated": rememberStay stores
  // the cleared flag only from here (and from a completed range's opposite).
  rememberStay();
  persistFilters();
});

// --- category filter popover ----------------------------------------------

/** The static checkbox values in index.html ARE the vocabulary strings. */
const categoryBoxes = Array.from(
  typePopover.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
);

function selectedCategories(): SearchCategory[] {
  return categoryBoxes.filter((box) => box.checked).map((box) => box.value as SearchCategory);
}

/** Count-only summary; the panel itself names the chosen types. */
function updateTypeSummary(): void {
  const count = selectedCategories().length;
  typeSummary.textContent =
    count === 0
      ? t('search.form.typeAny')
      : count === 1
        ? t('search.form.typeCountOne')
        : t(
            selectPlural(count, {
              one: 'search.form.typeCountOne',
              few: 'search.form.typeCountFew',
              many: 'search.form.typeCountMany',
            }),
            { count },
          );
}

// --- filter persistence ---------------------------------------------------

/**
 * Controls the user has operated. The page's handlers are live from the first
 * paint, but the stored defaults only arrive once `init()`'s storage read
 * resolves — so a control touched inside that window would otherwise be
 * overwritten by the value the user has just replaced. Hydration skips
 * whatever is listed here; the same call sites that persist a change record it.
 */
const touched = new Set<string>();

/**
 * Whether the stored filters have been read yet, and whether a change arrived
 * before they had. `save()` REPLACES the whole `search` object with what this
 * page currently shows, so a write made from the un-hydrated page would store
 * the page's own defaults over the user's stored preferences — and hydration,
 * which skips touched controls, would never put them back. So nothing is
 * written until the load has landed; a change made in that window is flushed
 * once, afterwards, when the DOM holds the user's value for the control they
 * touched and the stored value for every control they did not.
 */
let hydrated = false;
let persistPending = false;

/**
 * The stay as it should be REMEMBERED, which is not always the stay on
 * screen. The first click of a new range leaves `{checkin}` and no checkout;
 * deriving "no dates" from that mid-edit state would store `stayCleared:
 * true` — a deliberate "search without dates" — over the pair the user still
 * has, and destroy it. Only a completed range and the explicit Clear control
 * update this (see `rememberStay`).
 */
let storedStay: { checkin?: string; checkout?: string; stayCleared: boolean } = {
  ...(stay.checkin !== undefined && stay.checkout !== undefined
    ? { checkin: stay.checkin, checkout: stay.checkout }
    : {}),
  stayCleared: false,
};

/**
 * Commit the stay on screen as the one to remember. Called ONLY from settled
 * states — a completed range, the Clear control, and hydration — never from a
 * half-picked one. Absent dates here therefore mean the user really did
 * choose to search without them.
 */
function rememberStay(): void {
  storedStay =
    stay.checkin !== undefined && stay.checkout !== undefined
      ? { checkin: stay.checkin, checkout: stay.checkout, stayCleared: false }
      : { stayCleared: true };
}

/**
 * Store the current filters as the next session's defaults, on every change.
 * Preferences only, never history: the drawn circle and the results are
 * deliberately NOT stored — no location traces — and the settings sanitizer
 * drops a stored stay once its check-in passes. Writes are one small object,
 * so no debounce.
 */
function persistFilters(): void {
  if (!hydrated) {
    persistPending = true;
    return;
  }
  void createSettingsStore().save({
    search: {
      // The remembered stay, not the one mid-edit on screen.
      ...storedStay,
      adults: adultsInput.valueAsNumber,
      rooms: roomsInput.valueAsNumber,
      children: childrenInput.valueAsNumber,
      categories: selectedCategories(),
      sort: sortSelect.value,
    },
  });
}

for (const input of [adultsInput, roomsInput, childrenInput]) {
  input.addEventListener('change', () => {
    touched.add(input.id);
    persistFilters();
  });
}

// No re-search on change — like every control here, the filter applies on the
// next explicit Search press. Only the summary count updates live.
typePopover.addEventListener('change', () => {
  touched.add('categories');
  updateTypeSummary();
  persistFilters();
});

// --- shared popover behaviour ---------------------------------------------

// One handler pair covers both popovers: a pointerdown anywhere outside an
// open <details> closes it (the element contains both summary and panel, so
// inside-clicks survive), Escape closes whichever is open, and opening one
// closes the other so at most one panel ever floats over the map.
const popovers = [datesPopover, typePopover];
document.addEventListener('pointerdown', (event) => {
  for (const popover of popovers) {
    if (popover.open && !popover.contains(event.target as Node)) popover.open = false;
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const popover of popovers) popover.open = false;
});
for (const popover of popovers) {
  popover.addEventListener('toggle', () => {
    if (!popover.open) return;
    for (const other of popovers) {
      if (other !== popover) other.open = false;
    }
  });
}

// First paint in English; init() re-renders once the stored language is
// active, the same way applyTranslations reworks the static markup.
renderCalendar();
updateTypeSummary();

// --- status line ----------------------------------------------------------

/**
 * What the status line currently says, kept as a RECIPE rather than as
 * rendered text. A language switch repaints from this, so the line the user is
 * actually looking at — "Area selected — press Search.", a refusal, the bot
 * check, an error — comes back in the new language instead of being replaced
 * by a sentence about some other state.
 *
 * `render` runs at paint time, so everything it derives from t() (directly, or
 * through the pure controller helpers that call t()) re-translates.
 *
 * Text we did not author — worker error strings, platform page titles — never
 * goes INTO the sentence. It used to be interpolated ("Could not check that
 * listing: {error}"), which left a Russian status line half-English. It is
 * carried as a separate `detail` instead: same information, rendered
 * visually secondary and verbatim (translating a foreign string would be a
 * lie), while the sentence around it stays whole and translatable.
 */
type Status =
  | { kind: 'line'; render: () => string; isError: boolean; detail?: string }
  | { kind: 'challenge' };

/** null = nothing has been said yet; init() fills the first line. */
let currentStatus: Status | null = null;

function paintStatus(): void {
  if (currentStatus === null) return;
  if (currentStatus.kind === 'challenge') {
    renderChallengeStatus();
    return;
  }
  statusEl.className = currentStatus.isError ? 'status err' : 'status';
  statusEl.replaceChildren(currentStatus.render());
  if (currentStatus.detail === undefined) return;
  // Secondary line, muted: the technical text is available (and copyable, and
  // in full on hover when it is long) without pretending to be our prose.
  const detail = document.createElement('span');
  detail.className = 'detail';
  detail.textContent = currentStatus.detail;
  detail.title = currentStatus.detail;
  statusEl.append(detail);
}

/** One catalog message. Params are values (counts, platform text), not keys. */
function setStatusKey(
  key: MessageKey,
  params?: Record<string, string | number>,
  isError = false,
  detail?: string,
): void {
  setStatusDerived(() => t(key, params), isError, detail);
}

/** A line assembled by a pure helper — re-derived, so its words re-translate. */
function setStatusDerived(render: () => string, isError = false, detail?: string): void {
  currentStatus = { kind: 'line', render, isError, ...(detail === undefined ? {} : { detail }) };
  // Any new line supersedes whatever a listing check had claimed: a check
  // whose failure lands later must not overwrite what is on screen now.
  statusFlight = 0;
  paintStatus();
}

/**
 * Listing checks are numbered so a failure can tell whether the status line
 * still belongs to it. `statusFlight` is the flight the current line was
 * written for (0 = none): the worker answers `{ok:false}` for checks the user
 * has already moved on from, and painting that failure over a newer line —
 * another check, a fresh search, a new selection — would report a stale
 * failure as if it were the current state.
 */
let checkFlights = 0;
let statusFlight = 0;

/** The bot-check status is markup (it carries a link), so it paints itself. */
function showChallengeStatus(): void {
  currentStatus = { kind: 'challenge' };
  statusFlight = 0; // like every other line: no listing check owns this one
  paintStatus();
}

// --- map ------------------------------------------------------------------

const map = L.map('map').setView([48.8566, 2.3522], 12);
// The tile layer is added in init(): its attribution line carries translated
// text, so it must wait for the active language.

// --- circle selection (no plugin) -----------------------------------------
//
// The drag draws a CIRCLE: press a centre, pull outward, and the radius line
// carries the distance as you go. It used to draw a rectangle, which
// `bboxToQuery` then turned into a centre and a half-diagonal — so the region
// actually searched was never the region drawn, and it bulged well past the
// edges of the box the user was looking at. The platform's search takes a
// centre and a radius natively, so the drawn shape is one too, and the number
// that will be sent is on screen while the user chooses it.

const CIRCLE_COLOR = '#2f6feb';
const DRAFT_STYLE: L.PathOptions = { color: CIRCLE_COLOR, weight: 2, fillOpacity: 0.06, dashArray: '6 4' };
// Empty dashArray makes Leaflet's SVG renderer remove the dash attribute.
const FIXED_STYLE: L.PathOptions = { color: CIRCLE_COLOR, weight: 2, fillOpacity: 0.12, dashArray: '' };
const SPOKE_STYLE: L.PathOptions = { color: CIRCLE_COLOR, weight: 2, dashArray: '4 4' };

let drawing = false;
let dragCentre: L.LatLng | null = null;
/** One circle instance, restyled and re-sized; never recreated per drag. */
let circle: L.Circle | null = null;
/** The radius line and its distance read-out: on screen only during a drag. */
let spoke: L.Polyline | null = null;
let radiusLabel: L.Marker | null = null;
/** The fixed selection the Search button will use. */
let selection: SearchCircle | null = null;

function setDrawing(on: boolean): void {
  drawing = on;
  drawButton.setAttribute('aria-pressed', String(on));
  mapEl.classList.toggle('drawing', on);
  if (on) {
    map.dragging.disable();
    setStatusKey('search.status.dragToDraw');
  } else {
    map.dragging.enable();
  }
}

/** Put the circle back to whatever the last fixed selection was, and take the
 * drag's guide line and label off the map — they belong to a live drag only. */
function restoreSelectionCircle(): void {
  hideDragGuides();
  if (circle === null) return;
  if (selection === null) {
    circle.remove();
  } else {
    circle.setLatLng(L.latLng(selection.latitude, selection.longitude));
    circle.setRadius(selection.radiusKm * 1000);
    circle.setStyle(FIXED_STYLE);
  }
}

function hideDragGuides(): void {
  spoke?.remove();
  radiusLabel?.remove();
}

/**
 * Draw the radius line and its read-out for the drag in progress.
 *
 * Past the cap the CIRCLE stops growing, so the line stops with it: the line
 * is redrawn to the point on the drawn edge rather than to the cursor, and the
 * label says "60 km (maximum)". The cap used to be applied invisibly at query
 * time and confessed in a sentence after the search had already run; a radius
 * the user can see is a limit they can work with instead.
 */
function paintDragGuides(centre: L.LatLng, cursor: L.LatLng, draggedKm: number): void {
  const capped = draggedKm > MAX_RADIUS_KM;
  const end = capped ? pointTowards(centre, cursor, MAX_RADIUS_KM / draggedKm) : cursor;
  const drawnKm = capped ? MAX_RADIUS_KM : draggedKm;

  if (spoke === null) {
    spoke = L.polyline([centre, end], { ...SPOKE_STYLE, interactive: false }).addTo(map);
  } else {
    spoke.setLatLngs([centre, end]);
    spoke.addTo(map); // no-op when already on the map
  }

  if (radiusLabel === null) {
    // No iconSize/iconAnchor: the label's width depends on its text, so the
    // stylesheet sizes and offsets it rather than a fixed pixel box here.
    const icon = L.divIcon({ className: 'radius-label', html: '' });
    radiusLabel = L.marker(end, { icon, interactive: false, keyboard: false }).addTo(map);
  } else {
    radiusLabel.setLatLng(end);
    radiusLabel.addTo(map);
  }
  const { key, value } = formatRadius(drawnKm, activeLanguageTag());
  const el = radiusLabel.getElement();
  // textContent, never innerHTML: this text is ours, and the one HTML sink on
  // this page (Leaflet's attribution) is enough to keep track of.
  if (el != null) el.textContent = t(capped ? 'search.radius.capped' : key, { value });
}

/**
 * The point a `factor` of the way from `centre` to `cursor`, measured in
 * screen space so it lands exactly on the rendered circle's edge — Leaflet
 * draws the circle in projected pixels, so interpolating in degrees would
 * miss it by the Mercator stretch at this latitude.
 */
function pointTowards(centre: L.LatLng, cursor: L.LatLng, factor: number): L.LatLng {
  const from = map.latLngToLayerPoint(centre);
  const to = map.latLngToLayerPoint(cursor);
  return map.layerPointToLatLng(from.add(to.subtract(from).multiplyBy(factor)));
}

drawButton.addEventListener('click', () => {
  if (drawing) {
    dragCentre = null;
    restoreSelectionCircle();
    setDrawing(false);
    setStatusKey('search.status.selectionCancelled');
  } else {
    setDrawing(true);
  }
});

const container = map.getContainer();

container.addEventListener('pointerdown', (event) => {
  if (!drawing || event.button !== 0) return;
  event.preventDefault();
  container.setPointerCapture(event.pointerId);
  dragCentre = map.mouseEventToLatLng(event);
  if (circle === null) {
    circle = L.circle(dragCentre, { ...DRAFT_STYLE, radius: 0, interactive: false }).addTo(map);
  } else {
    circle.setLatLng(dragCentre);
    circle.setRadius(0);
    circle.setStyle(DRAFT_STYLE);
    circle.addTo(map); // no-op when already on the map
  }
  paintDragGuides(dragCentre, dragCentre, 0);
});

container.addEventListener('pointermove', (event) => {
  if (!drawing || dragCentre === null || circle === null) return;
  const cursor = map.mouseEventToLatLng(event);
  const draggedKm = radiusKmBetween(dragCentre, cursor);
  // `haversineKm` answers NaN for a point it will not read — a cursor dragged
  // several world-copies past the antimeridian produces one — and Leaflet
  // THROWS on a NaN radius. Freeze the drawn circle at its last measured size
  // instead: an unreadable pointer position is not a new radius.
  if (!Number.isFinite(draggedKm)) return;
  // Leaflet takes the radius in METRES; ours is km everywhere else.
  circle.setRadius(Math.min(draggedKm, MAX_RADIUS_KM) * 1000);
  paintDragGuides(dragCentre, cursor, draggedKm);
});

container.addEventListener('pointerup', (event) => {
  if (!drawing || dragCentre === null || event.button !== 0) return;
  const centre = dragCentre;
  const draggedKm = radiusKmBetween(centre, map.mouseEventToLatLng(event));
  dragCentre = null;
  setDrawing(false);
  // A click (or a drag the projection could not measure) is not a circle.
  if (!(draggedKm > 0)) {
    restoreSelectionCircle();
    if (selection === null) {
      searchButton.disabled = true;
      setStatusKey('search.status.clickNotAreaNoSelection', undefined, true);
    } else {
      setStatusKey('search.status.clickNotAreaKept', undefined, true);
    }
    return;
  }
  hideDragGuides();
  circle?.setStyle(FIXED_STYLE);
  // What is stored is what is DRAWN: the circle stopped growing at the cap, so
  // the query stops there too, with nothing left to clamp behind the user's
  // back. Session-only — `settings.search` deliberately stores no location.
  selection = {
    latitude: centre.lat,
    longitude: centre.lng,
    radiusKm: Math.min(draggedKm, MAX_RADIUS_KM),
  };
  // A search in flight keeps the button off: re-enabling here would allow a
  // second concurrent search whose status and results interleave with the
  // first (runSearch's finally re-enables once the flight lands).
  searchButton.disabled = searchInFlight;
  setStatusKey('search.status.areaSelected');
});

container.addEventListener('pointercancel', () => {
  if (!drawing) return;
  dragCentre = null;
  restoreSelectionCircle();
  setDrawing(false);
  setStatusKey('search.status.selectionCancelled');
});

// --- search flow ----------------------------------------------------------

/** Whether the search in flight carried dates, for the results status line. */
let lastSearchDated = false;
/** The circle the search in flight was built from — what the results are
 * filtered against (the user can redraw while a flight is up; `selection` may
 * have moved on, and the answer belongs to the circle that was searched). */
let lastSearchCircle: SearchCircle | null = null;
/** One search at a time: set for the whole flight, read by the draw handler. */
let searchInFlight = false;

/**
 * The last completed search's status inputs — kept so a language switch can
 * re-derive the same status line in the new language instead of blanking it.
 * `count` is what is on screen (inside the circle); `dropped` is what the
 * platform sent from outside it and the page is not showing.
 */
let lastResults: { count: number; dropped: number; dated: boolean } | null = null;

/** The post-search status: what was found inside the area, and what was not. */
function showResultsStatus(): void {
  setStatusDerived(resultsStatusText);
}

/** Read at paint time, so a language switch re-derives the same line. */
function resultsStatusText(): string {
  if (lastResults === null) return t('search.status.pressSelectThenDrag');
  const base = resultsStatus(lastResults.count, lastResults.dated);
  // Appended, never replacing: the count of what IS shown stays visible
  // alongside the admission of what was dropped.
  const outside = outsideAreaLine(lastResults.dropped);
  return outside === '' ? base : `${base} ${outside}`;
}

async function runSearch(): Promise<void> {
  if (searchInFlight || selection === null) {
    if (selection === null) setStatusKey('search.status.selectFirst', undefined, true);
    return;
  }
  // The calendar can legitimately hold a check-in with no check-out yet (the
  // user closed the popover mid-selection); readStayDates refuses that
  // one-sided state with its own message, same as it refused half-filled
  // inputs before.
  const dates = readStayDates(stay.checkin ?? '', stay.checkout ?? '');
  if (dates.kind === 'refused') {
    setStatusKey(dates.messageKey, undefined, true);
    return;
  }
  const occupancy = {
    adults: adultsInput.valueAsNumber,
    rooms: roomsInput.valueAsNumber,
    children: childrenInput.valueAsNumber,
  };
  const query = circleToQuery(selection, {
    ...(dates.kind === 'dated' ? { checkin: dates.checkin, checkout: dates.checkout } : {}),
    ...occupancy,
    // circleToQuery drops an empty selection: no boxes ticked = no filter.
    categories: selectedCategories(),
    // NO sort hint is ever sent, whatever the local sort control says. Asking
    // the platform for `order=price` made it answer with the cheapest places
    // across a whole region rather than the nearest ones: a small area
    // over central Paris came back with Le Mée-sur-Seine, Melun and Plaisir,
    // 42 km away, because the radius is loosely respected at best and the
    // price order overrode proximity entirely. The platform's DEFAULT order
    // is proximity-ish, which keeps the answer near what was drawn; the
    // user's chosen sort is applied locally by `sortCards` afterwards, on
    // results that are actually in the area.
    // Our UI language, so the platform localizes its own card text
    // (distances, addresses). The lib omits '' (English) automatically.
    language: languageSelect.value,
  });
  if (query === null) {
    // Re-derived on a language switch (the refusal names a form field, whose
    // label is itself translated), so the circle and counts are captured, not
    // the sentence they produce.
    const refused = selection;
    setStatusDerived(() => explainQueryRefusal(refused, occupancy), true);
    return;
  }
  lastSearchDated = dates.kind === 'dated';
  // The query's radius, not the drawn one: identical unless a sub-500 m drag
  // was raised to the floor, and the results are filtered against what was
  // actually searched.
  lastSearchCircle = { ...selection, radiusKm: query.radiusKm };
  lastResults = null;
  clearResults();
  setStatusKey('search.status.searching');
  searchInFlight = true;
  searchButton.disabled = true;
  let response: SearchAreaFetchResponse | undefined;
  try {
    const message: SearchAreaFetchMessage = { type: 'SEARCH_AREA_FETCH', platform: PLATFORM_ID, query };
    response = (await browser.runtime.sendMessage(message)) as SearchAreaFetchResponse | undefined;
  } catch (error) {
    setStatusKey('search.status.couldNotReachWorker', undefined, true, String(error));
    return;
  } finally {
    searchInFlight = false;
    searchButton.disabled = selection === null;
  }
  handleResponse(response);
}

searchButton.addEventListener('click', () => {
  void runSearch();
});

function handleResponse(response: SearchAreaFetchResponse | undefined): void {
  // Every way out of here except the rendered one leaves the screen with no
  // results, so clear once, up front: the list, the markers and `currentCards`
  // (what a language re-render repaints) must never disagree about that.
  clearResults();
  if (response === undefined) {
    setStatusKey('search.status.workerNoReply', undefined, true);
    return;
  }
  if (!response.ok) {
    // Our sentence either way; the worker's own (English) words ride along as
    // a secondary detail when it has some, instead of BEING the status line.
    if (response.error !== undefined) {
      setStatusKey('search.status.searchFailed', undefined, true, response.error);
    } else {
      setStatusKey('search.status.failedNoReason', undefined, true);
    }
    return;
  }
  if (response.outcome === 'challenge') {
    showChallengeStatus();
    return;
  }
  if (response.outcome === 'other') {
    // Honest about both readings: a zero-match area produces a page with no
    // result cards, which is indistinguishable (to the coarse assessor) from
    // a page that is not results at all. Say so instead of guessing.
    const title = titleOf(response.html);
    setStatusDerived(
      () =>
        t('search.status.noListingCards', { platform: platformLabel() }) +
        (title === null ? '' : ` ${t('search.status.replyTitle', { title })}`),
      true,
    );
    return;
  }
  if (response.outcome !== 'results' || response.html === undefined) {
    setStatusKey('search.status.noResultsHtml', undefined, true);
    return;
  }
  const doc = new DOMParser().parseFromString(response.html, 'text/html');
  const adapter = adapterById(PLATFORM_ID);
  if (adapter?.parseSearchResults === undefined) {
    setStatusKey(
      'search.status.adapterCannotParse',
      { platform: adapter?.label ?? PLATFORM_ID },
      true,
    );
    return;
  }
  const parsed = adapter.parseSearchResults(doc);
  // The platform is sent a centre and a radius and obeys them loosely: it has
  // returned places 42 km outside a city-block area. Enforce the drawn circle
  // here, on the cards' own coordinates, and drop only what those coordinates
  // PROVE is elsewhere (partitionByRadius keeps the rest).
  const searched = lastSearchCircle;
  const { inside, outside } =
    searched === null
      ? { inside: parsed, outside: [] as SearchResultCard[] }
      : partitionByRadius(searched, parsed);
  // One source of truth for both the list and the markers: only kept cards.
  renderCards(inside);
  lastResults = { count: inside.length, dropped: outside.length, dated: lastSearchDated };
  showResultsStatus();
}

/** The platform's display name, via the adapter — never hardcoded here. */
function platformLabel(): string {
  return adapterById(PLATFORM_ID)?.label ?? PLATFORM_ID;
}

/** The one status that needs markup: a real link to clear the bot check. */
function renderChallengeStatus(): void {
  statusEl.className = 'status err';
  statusEl.replaceChildren();
  statusEl.append(`${t('search.challenge.botCheck', { platform: platformLabel() })} `);
  // The homepage comes from the adapter (platform URLs live in lib/sites/);
  // without one we can still say what happened, just not link the fix.
  const homepage = adapterById(PLATFORM_ID)?.homepage;
  if (homepage === undefined) {
    statusEl.append(t('search.challenge.openSite'));
    return;
  }
  // The sentence is split around the anchor so translations keep the link on
  // the hostname, not on translated prose.
  statusEl.append(`${t('search.challenge.openLinkBefore')} `);
  const link = document.createElement('a');
  link.href = homepage;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = new URL(homepage).hostname;
  statusEl.append(link, ` ${t('search.challenge.openLinkAfter')}`);
}

/** First 120 chars of the response's <title>, or null. */
function titleOf(html: string | undefined): string | null {
  if (html === undefined) return null;
  const title = new DOMParser().parseFromString(html, 'text/html').title.trim();
  return title === '' ? null : title.slice(0, 120);
}

// --- results list + markers -----------------------------------------------

const sortField = byId<HTMLLabelElement>('sort-field');
const sortSelect = byId<HTMLSelectElement>('sort');
/**
 * What is on screen right now — the single source of truth for the list and
 * the markers, re-rendered whenever the sort mode or the language changes.
 * Emptied by `clearResults` together with the DOM it describes, so a re-render
 * can never resurrect a result set the user already saw disappear.
 */
let currentCards: SearchResultCard[] = [];
/** One layer group holds every result marker; cleared per render. */
const markersLayer = L.layerGroup().addTo(map);

/**
 * The selected result, held by PROPERTY (see `selectionKey`) rather than by
 * ordinal — sorting renumbers the list, and a language switch rebuilds it, so
 * a selection kept by position would drift onto another property. null = no
 * selection; a key whose property the latest results no longer list is dropped
 * by `renderCards` rather than left pointing at nothing.
 */
let selectedKey: string | null = null;
/** Selection key → its marker, rebuilt per render alongside the list. */
const markerByKey = new Map<string, L.Marker>();

/** Empty the results — list, markers, sort control and the record of them. */
function clearResults(): void {
  currentCards = [];
  resultsList.replaceChildren();
  markersLayer.clearLayers();
  markerByKey.clear();
  sortField.hidden = true;
}

/**
 * Paint the current selection on both sides of the page at once, so the card
 * and its dot always agree about which property is selected. Targeted, not a
 * re-render: selecting must not rebuild the list (that would drop keyboard
 * focus and re-run every lazy image load).
 *
 * Nothing here reads `selectedKey` into a CSS selector — result URLs are
 * attacker-adjacent, and a key interpolated into `querySelector` would be a
 * selector-injection sink. The list is walked instead.
 */
function paintSelection(): void {
  for (const item of resultsList.querySelectorAll<HTMLLIElement>('li.result')) {
    const on = selectedKey !== null && item.dataset.key === selectedKey;
    item.classList.toggle('selected', on);
    const badge = item.querySelector<HTMLButtonElement>('button.result-ordinal');
    // aria-current, not aria-pressed: this is the current one OF A SET, and
    // clicking it again re-selects rather than toggling off.
    if (on) badge?.setAttribute('aria-current', 'true');
    else badge?.removeAttribute('aria-current');
  }
  for (const [key, marker] of markerByKey) {
    const on = key === selectedKey;
    marker.getElement()?.classList.toggle('selected', on);
    // The selected dot draws over its neighbours; overlapping results are the
    // normal case in a dense area, and a highlight hidden behind another dot
    // would be no highlight at all.
    marker.setZIndexOffset(on ? 1000 : 0);
  }
}

/** The list item for the current selection, found by walking (see above). */
function selectedItem(): HTMLLIElement | null {
  if (selectedKey === null) return null;
  for (const item of resultsList.querySelectorAll<HTMLLIElement>('li.result')) {
    if (item.dataset.key === selectedKey) return item;
  }
  return null;
}

/**
 * Select a result. `reveal` names the side the click did NOT come from: a
 * click in the list brings the marker into view, a click on the marker brings
 * the card into view. Whichever side was clicked is already where the user is
 * looking, and moving it would be moving something under their hand.
 *
 * A card with no coordinates has no marker (see `addMarker`); it still
 * selects, there is simply nothing on the map to reveal.
 */
function selectResult(key: string, reveal: 'marker' | 'card'): void {
  selectedKey = key;
  paintSelection();
  if (reveal === 'marker') {
    const marker = markerByKey.get(key);
    if (marker !== undefined) revealMarker(marker);
  } else {
    // 'nearest' scrolls the results panel only as far as it must, and never
    // scrolls the page itself — a selection is not a navigation.
    selectedItem()?.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Bring a marker on screen ONLY when it is genuinely off screen. No zoom, and
 * no pan when it is already visible: the user positioned this map, and a
 * selection that yanks it is a selection that fights them.
 */
function revealMarker(marker: L.Marker): void {
  const position = marker.getLatLng();
  if (map.getBounds().contains(position)) return;
  map.panTo(position);
}

// One delegated handler covers every card, and covers the keyboard for free:
// Enter/Space on the badge button dispatches a click that bubbles to here, so
// there is exactly one selection path and no double-fire.
resultsList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  // The two labelled actions keep doing exactly what they do — checking the
  // listing and opening it are not selections, and selecting must not swallow
  // a click meant for either.
  if (target.closest('.card-actions') !== null) return;
  const key = target.closest<HTMLLIElement>('li.result')?.dataset.key;
  if (key === undefined) return;
  selectResult(key, 'marker');
});

sortSelect.value = DEFAULT_SORT;
sortSelect.addEventListener('change', () => {
  touched.add('sort');
  // Re-render IN PLACE (same reasoning as the language switch): reordering a
  // list the user is already looking at must not re-fit the map and throw
  // away the pan and zoom they chose.
  renderCards(currentCards, false);
  persistFilters();
});

/**
 * Wire the "check this listing" button: the click asks the worker to analyze
 * the listing and publish the verdict to the side panel.
 *
 * This used to be an invisible behaviour — an intercepted click on the
 * result's name, announced only by a `title=` tooltip — so the feature the
 * docs describe was, in practice, undiscoverable. It is a labelled button
 * now. The button is disabled while its own flight is up (double-clicks), but
 * flights on different cards may overlap — the worker rate-limits.
 */
function wireCheckButton(button: HTMLButtonElement, url: string, name: string): void {
  let inFlight = false;
  button.addEventListener('click', () => {
    if (inFlight) return;
    inFlight = true;
    button.disabled = true;
    // Claim the status line for THIS check, so a failure that lands after the
    // user has moved on can tell that the line is no longer its own.
    const flight = ++checkFlights;
    // Said before the round trip, not after it: the fetch and parse take
    // seconds, and a click with no acknowledgement reads as a dead control.
    setStatusKey('search.status.checkingListing', { name });
    statusFlight = flight;
    void (async () => {
      try {
        // Chrome retires the service worker eventually, which takes the port
        // with it; re-announce before asking, so the verdict this click is
        // about is guarded by a live one.
        presence.ensure();
        const message: SearchFocusListingMessage = { type: 'SEARCH_FOCUS_LISTING', url };
        const response = (await browser.runtime.sendMessage(message)) as
          | SearchFocusListingResponse
          | undefined;
        // Success leaves the "Checking …" line standing — the side panel
        // takes it from here; only a failure has news.
        if (response?.ok !== true) reportCheckFailure(flight, response?.error);
      } catch (error) {
        reportCheckFailure(flight, String(error));
      } finally {
        inFlight = false;
        button.disabled = false;
      }
    })();
  });
}

/**
 * Report a failed check — but only while the status line still belongs to
 * that check. A superseded flight (the user started another check, ran a new
 * search, drew a new area) has no claim on what the line now says, and the
 * worker does answer `{ok:false}` for flights nobody is waiting on any more.
 */
function reportCheckFailure(flight: number, detail: string | undefined): void {
  if (statusFlight !== flight) return;
  setStatusKey('search.status.couldNotCheck', undefined, true, detail);
}

/** The secondary action: actually open the listing on the platform. */
function makeOpenLink(url: string): HTMLAnchorElement {
  const open = document.createElement('a');
  open.className = 'open-link';
  open.href = url;
  open.target = '_blank';
  // A real <a href> with no click handler of its own, so a modified click
  // (new tab, new window) and a middle click behave exactly as the browser
  // promises — this is the one control on a card that navigates.
  open.rel = 'noopener';
  open.textContent = t('search.card.open');
  return open;
}

/**
 * The two actions every result offers, both explicitly labelled: check it
 * here, or open it on the platform. Same pair on the list card and in the
 * marker popup, so the map and the list can do the same things.
 */
function makeCardActions(url: string, name: string): HTMLDivElement {
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check-button';
  check.textContent = t('search.card.check');
  wireCheckButton(check, url, name);
  actions.append(check, makeOpenLink(url));
  return actions;
}

function renderCards(cards: SearchResultCard[], fit = true): void {
  currentCards = cards;
  sortField.hidden = cards.length === 0;
  const sorted = sortCards(cards, sortSelect.value as SortMode);
  // The selection is keyed to the property, so it survives this rebuild — a
  // re-sort renumbers the ordinals around it, a language switch re-renders
  // under it. Only a result set that no longer contains the property drops it.
  if (findByKey(sorted, selectedKey) === null) selectedKey = null;
  resultsList.replaceChildren();
  markersLayer.clearLayers();
  markerByKey.clear();
  sorted.forEach((card, index) => {
    resultsList.append(renderCard(card, index + 1));
    addMarker(card, index + 1);
  });
  paintSelection();
  if (!fit) return; // a re-render in place (language switch) must not pan the map
  // Bring every marker into view, but never zoom IN past the user's own
  // framing — a search should reveal results, not fling the map about.
  const positions = sorted
    .filter((card) => card.latitude !== undefined && card.longitude !== undefined)
    .map((card) => L.latLng(card.latitude as number, card.longitude as number));
  if (positions.length > 0) {
    map.fitBounds(L.latLngBounds(positions), { padding: [32, 32], maxZoom: map.getZoom() });
  }
}

/**
 * A numbered dot matching the card's position in the (sorted) list, so map
 * and list read as one. Neutral styling on purpose: verdict-coloured pins
 * are phase (c), and a colour here would look like a judgment we have not
 * made. Cards without coordinates simply have no dot — the list still shows
 * them, and inventing a position would be worse than omitting one.
 */
function addMarker(card: SearchResultCard, ordinal: number): void {
  if (card.latitude === undefined || card.longitude === undefined) return;
  const icon = L.divIcon({
    className: 'result-marker',
    html: '', // content set via textContent below — never HTML from page data
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  const marker = L.marker([card.latitude, card.longitude], { icon, title: card.name });
  marker.addTo(markersLayer);
  const el = marker.getElement();
  if (el !== undefined) el.textContent = String(ordinal);
  // Selection is symmetric: a click on the dot selects the same result a click
  // on the card does, and scrolls that card into view in the results panel.
  // The popup opens on the same click, as it always has.
  const key = selectionKey(card);
  // First card wins a repeated key, matching `findByKey`, so the list and the
  // marker map can never disagree about which card a selection refers to.
  if (!markerByKey.has(key)) markerByKey.set(key, marker);
  marker.on('click', () => {
    selectResult(key, 'card');
  });
  // Same two labelled actions as the list card. The name is plain text: the
  // check lives on its own button, so nothing here is a hidden behaviour on
  // a click target that looks like a link to the listing.
  const popup = document.createElement('div');
  popup.className = 'marker-popup';
  const safeUrl = httpUrl(card.url);
  // The property photo, exactly as the list card admits it: through the
  // http(s) gate, lazily, and decorative (`alt=""`) because the name sits
  // right beside it and is the real label. A card with no usable thumbnail
  // simply has no <img>, so the popup keeps the shape it has always had.
  const popupThumbnail = httpUrl(card.thumbnailUrl);
  if (popupThumbnail !== null) {
    const photo = document.createElement('img');
    photo.src = popupThumbnail;
    photo.loading = 'lazy';
    photo.alt = '';
    popup.append(photo);
  }
  const title = document.createElement('div');
  title.className = 'name';
  title.textContent = card.name;
  popup.append(title);
  if (card.priceText !== undefined) {
    const price = document.createElement('div');
    price.textContent = card.priceText;
    popup.append(price);
  }
  // A card whose URL failed the http(s) gate offers neither action.
  if (safeUrl !== null) popup.append(makeCardActions(safeUrl, card.name));
  marker.bindPopup(popup);
}

function renderCard(card: SearchResultCard, ordinal: number): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'result';
  // Identity, never a link: the delegated click handler reads it back to learn
  // which property was clicked, and it survives the renumbering a re-sort does.
  item.dataset.key = selectionKey(card);

  // The same number the card's map dot carries, so list and map correlate —
  // and a real button, not a decorative span, because pointing out that dot is
  // an action and keyboard users must be able to take it. Clicking anywhere on
  // the card does the same thing; this is where it is announced and focusable.
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'result-ordinal';
  badge.textContent = String(ordinal);
  const showOnMap = t('search.card.showOnMap', { name: card.name });
  badge.setAttribute('aria-label', showOnMap);
  badge.title = showOnMap;
  item.append(badge);

  const thumbnail = httpUrl(card.thumbnailUrl);
  if (thumbnail !== null) {
    const img = document.createElement('img');
    img.src = thumbnail;
    img.loading = 'lazy';
    img.alt = '';
    item.append(img);
  }

  const body = document.createElement('div');
  const cardUrl = httpUrl(card.url);
  // The name is a label, not a control: every action this card offers is
  // spelled out — the two in the button row below, and selecting it on the
  // map, which the numbered button above says in words. So a click anywhere
  // on the card does something visible, reversible and announced, and never
  // navigates.
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = card.name;
  body.append(name);

  const metaLines: string[] = [];
  if (card.priceText !== undefined) metaLines.push(card.priceText);
  if (card.reviewScore !== undefined) metaLines.push(reviewLine(card.reviewScore, card.reviewCount));
  if (card.address !== undefined) metaLines.push(card.address);
  if (card.distanceText !== undefined) metaLines.push(card.distanceText);
  for (const line of metaLines) {
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = line;
    body.append(meta);
  }

  // A card whose URL failed the http(s) gate keeps its name and metadata but
  // offers no actions — there is nothing safe to check or open.
  if (cardUrl !== null) body.append(makeCardActions(cardUrl, card.name));

  item.append(body);
  return item;
}

// --- language + startup ---------------------------------------------------

/**
 * The OSM attribution carries one translated word, so it must be replaced on
 * a language switch. Leaflet renders attribution via innerHTML — the ONE sink
 * where a catalog string meets HTML — so the machine-translated word is
 * entity-escaped: a hostile catalog regeneration must never become markup.
 * Required by the OSM tile usage policy — must stay visible.
 */
let osmAttribution = '';
function updateAttribution(): void {
  if (osmAttribution !== '') map.attributionControl.removeAttribution(osmAttribution);
  osmAttribution =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    escapeHtml(t('search.map.contributors'));
  map.attributionControl.addAttribution(osmAttribution);
}

languageSelect.addEventListener('change', () => {
  void (async () => {
    // save() returns the sanitized settings; activate what was actually kept.
    const saved = await createSettingsStore().save({ language: languageSelect.value });
    // Re-translate IN PLACE — a reload here used to cost users their drawn
    // circle, results and half-filled filters (none of which are persisted:
    // no location traces in storage). Static markup re-runs through the
    // catalog; every dynamically-rendered text is re-rendered by hand below.
    activateLanguage(saved.language);
    applyTranslations(document);
    document.title = t('search.title');
    renderCalendar(); // month/weekday names, summary, hint
    updateTypeSummary();
    updateAttribution();
    // Results re-render localizes review lines, "Open listing" links and the
    // check-link titles; the card content itself stays the platform's text.
    // `currentCards` IS what is on screen, so an emptied list stays empty.
    renderCards(currentCards, false);
    // Repaint whatever the status actually says — the results line, a
    // refusal, "Searching…", the bot check — in the new language.
    paintStatus();
  })();
});

/**
 * Startup is async solely because the language lives in storage: nothing may
 * render text before the stored catalog is active, so every text-producing
 * step (translations, title, OSM attribution, the first status) waits here.
 */
async function init(): Promise<void> {
  const settings = await createSettingsStore().load();
  activateLanguage(settings.language);
  applyTranslations(document);
  document.title = t('search.title');

  // Hydrate the filters from the stored defaults (preferences, not history —
  // no drawn area or coordinates are ever stored), skipping every control the
  // user already operated while this read was in flight: their input is newer
  // than the store and must not be overwritten by it.
  const savedSearch = settings.search;
  if (!touched.has('dates')) {
    // Dates when the sanitizer kept a pair (stale stays were dropped on read),
    // an empty stay when the last session deliberately cleared them, and
    // otherwise the page's own "a month out, two nights" default.
    if (savedSearch.checkin !== undefined && savedSearch.checkout !== undefined) {
      stay = { checkin: savedSearch.checkin, checkout: savedSearch.checkout };
      visibleMonth = monthOf(savedSearch.checkin);
    } else if (savedSearch.stayCleared) {
      stay = {};
      visibleMonth = monthOf(todayIso());
    }
  }
  if (!touched.has('adults')) adultsInput.value = String(savedSearch.adults);
  if (!touched.has('rooms')) roomsInput.value = String(savedSearch.rooms);
  if (!touched.has('children')) childrenInput.value = String(savedSearch.children);
  if (!touched.has('categories')) {
    for (const box of categoryBoxes) box.checked = savedSearch.categories.includes(box.value);
  }
  if (!touched.has('sort')) sortSelect.value = savedSearch.sort;

  // What to REMEMBER for the stay is the store's own answer — unless the user
  // completed a range while this read was in flight, in which case theirs is
  // newer. A half-picked range is not an answer at all and leaves the stored
  // pair alone (see `storedStay`).
  storedStay = {
    ...(savedSearch.checkin !== undefined && savedSearch.checkout !== undefined
      ? { checkin: savedSearch.checkin, checkout: savedSearch.checkout }
      : {}),
    stayCleared: savedSearch.stayCleared,
  };
  if (touched.has('dates') && stay.checkin !== undefined && stay.checkout !== undefined) {
    rememberStay();
  }

  // Writes are safe from here: every control now holds either the user's own
  // value or the stored one, so persisting the whole object cannot lose a
  // preference. A change made while this read was in flight is flushed once.
  hydrated = true;
  if (persistPending) {
    persistPending = false;
    persistFilters();
  }

  // Re-render the dynamic controls (calendar grid, both popover summaries):
  // their text comes from t()/Intl at render time, which data-i18n cannot
  // reach — and the hydrated values above must show, not the first paint.
  renderCalendar();
  updateTypeSummary();

  for (const { code, name } of SUPPORTED_LANGUAGES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    languageSelect.append(option);
  }
  languageSelect.value = settings.language;

  // Attribution is managed by updateAttribution (not the layer option) so a
  // language switch can swap its one translated word without a reload.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  updateAttribution();

  // The interactive handlers are live while init() awaits storage; if the
  // user already produced a status in that window, keep theirs, not ours.
  if (currentStatus === null) setStatusKey('search.status.pressSelectThenDrag');
  else paintStatus(); // theirs, but rendered before the catalog was active
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

void init();
