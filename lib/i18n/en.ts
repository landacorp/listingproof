import { engineaMessages } from './en/enginea';
import { enginelMessages } from './en/enginel';
import { reviewsMessages } from './en/reviews';
import { scoreMessages } from './en/score';
import { termsMessages } from './en/terms';

/**
 * The English source catalog — the authority every other locale is machine-
 * translated FROM (scripts/translate-catalog.ts) and the fallback every
 * missing translation lands ON.
 *
 * Grammar of an entry: `{param}` slots are filled at call time and NEVER
 * translated — platform labels, hostnames, counts, page quotes. Keys are
 * dot-namespaced by surface. Plurals are separate keys (`…One` / `…Many`):
 * a tiny catalog does not earn an ICU runtime, and machine translation
 * handles two whole sentences far better than one templated half-sentence.
 *
 * Scope: the UI chrome lives here; the engine-generated evidence prose lives
 * in `./en/*.ts` and is merged in below, so several authors can add engine
 * messages without colliding in one file. Engines author keys and facts (see
 * `lib/msg.ts`); nothing in the analysis pipeline holds a second copy of the
 * English words.
 */
const uiMessages = {
  // Shared
  'common.language': 'Language',

  // Map-search page
  'search.title': 'ListingProof — map search',
  'search.form.adults': 'Adults',
  'search.form.rooms': 'Rooms',
  'search.form.children': 'Children',
  'search.form.selectArea': 'Select area',
  'search.form.search': 'Search',
  'search.results.ariaLabel': 'Search results',
  'search.map.contributors': 'contributors',
  'search.sort.label': 'Sort by',
  'search.sort.cheapest': 'Cheapest first',
  'search.sort.expensive': 'Most expensive first',
  'search.sort.bestRated': 'Best rated first',
  'search.sort.platformOrder': 'Platform order',
  'search.status.pressSelectThenDrag': 'Press "Select area", then drag on the map.',
  'search.status.dragToDraw':
    'Press a centre point on the map and drag outward to set the search radius.',
  'search.status.selectionCancelled': 'Area selection cancelled.',
  'search.status.clickNotAreaNoSelection':
    'That was a click, not an area — press "Select area", then drag outward from a centre point.',
  'search.status.clickNotAreaKept': 'That was a click, not an area — keeping the previous selection.',
  'search.status.areaSelected': 'Area selected — press Search.',
  'search.status.selectFirst': 'Select an area first.',
  'search.status.searching': 'Searching…',
  // The live read-out along the radius line while the circle is being drawn.
  // Unit words, not sentences: the number arrives already formatted for the
  // reader's locale (Intl), so only the unit needs translating.
  'search.radius.metres': '{value} m',
  'search.radius.km': '{value} km',
  // Shown instead of the plain distance once the drag passes the search
  // radius limit and the drawn circle stops growing — the cap is visible
  // while dragging rather than sprung on the user after the search.
  'search.radius.capped': '{value} km (maximum)',
  'search.status.resultsZero': '0 places found in this area.',
  'search.status.resultsOne': '1 place found.',
  'search.status.resultsMany': '{count} places found.',
  'search.status.resultsOneDated': '1 place found — prices are for your dates.',
  'search.status.resultsManyDated': '{count} places found — prices are for your dates.',
  // Cards the platform returned that the drawn circle does not contain: the
  // answer is not bound to the radius, so the page filters and says so.
  'search.status.outsideAreaOne':
    '1 result the platform returned lay outside the drawn area and is not listed.',
  'search.status.outsideAreaFew':
    '{count} results the platform returned lay outside the drawn area and are not listed.',
  'search.status.outsideAreaMany':
    '{count} results the platform returned lay outside the drawn area and are not listed.',
  // Failure sentences stay whole and translatable; the worker's own English
  // technical text is shown beside them as a secondary detail, never spliced
  // into the sentence (a Russian UI must not read half-English).
  'search.status.couldNotReachWorker': "Could not reach the extension's background worker.",
  'search.status.workerNoReply': 'The background worker sent no reply.',
  'search.status.searchFailed': 'The search failed.',
  'search.status.failedNoReason': 'The search failed, and the worker gave no reason.',
  'search.status.noListingCards':
    "{platform}'s reply has no listing cards — the area may simply have none, or the reply was not a results page.",
  'search.status.replyTitle': 'Its title: “{title}”',
  'search.status.noResultsHtml': 'The worker reported success but sent no results HTML.',
  'search.status.adapterCannotParse':
    'The {platform} adapter cannot parse search results yet, so this page has nothing to show.',
  'search.challenge.botCheck': '{platform} is showing its bot check to the extension.',
  'search.challenge.openSite': 'Open the site in a normal tab once, then search again.',
  'search.challenge.openLinkBefore': 'Open',
  'search.challenge.openLinkAfter': 'in a normal tab once, then search again.',
  'search.dates.setBothOrClear': 'Set both dates, or clear both to search without dates.',
  'search.dates.checkoutAfterCheckin': 'Check-out must be after check-in.',
  'search.refusal.invalidCircle': 'The selected area is not a valid circle — draw it again.',
  'search.refusal.zeroSize': 'The selected area has no radius — draw the circle again.',
  'search.refusal.outOfBounds':
    'The centre of the selected area is off the world map — draw it inside one copy of the map.',
  'search.refusal.countRange': '{label} must be a whole number from {min} to {max}.',
  'search.refusal.unanticipated':
    'The search request failed validation for a reason this page did not anticipate.',
  'search.card.reviewLineOne': '{score} · 1 review',
  'search.card.reviewLineFew': '{score} · {count} reviews',
  'search.card.reviewLineMany': '{score} · {count} reviews',
  'search.form.dates': 'Dates',
  'search.dates.choose': 'Choose dates',
  'search.dates.withoutDates': 'Search without dates',
  'search.dates.hintStart': 'Pick the check-in day.',
  'search.dates.hintEnd': 'Now pick the check-out day.',
  'search.dates.nightsOne': '1 night',
  // The Few forms serve languages whose grammar bends at 2-4 (pl/ru/uk);
  // English never selects them. Their ru/pl/uk values are hand-corrected in
  // the locale files (the generator preserves them across regens).
  'search.dates.nightsFew': '{count} nights',
  'search.dates.nightsMany': '{count} nights',
  'search.dates.prevMonth': 'Previous month',
  'search.dates.nextMonth': 'Next month',
  'search.form.type': 'Type',
  'search.form.typeAny': 'Any type',
  'search.form.typeCountOne': '1 type',
  'search.form.typeCountFew': '{count} types',
  'search.form.typeCountMany': '{count} types',
  'search.card.check': 'Check this listing',
  'search.card.open': 'Open listing',
  // The numbered badge on a result card is a real button: it selects the
  // result and points out its dot on the map. Naming the property keeps the
  // accessible names of a list of these distinct from one another.
  'search.card.showOnMap': 'Show {name} on the map',
  'search.status.checkingListing':
    'Checking “{name}” — the verdict appears in the ListingProof side panel (click the toolbar icon if it is closed).',
  'search.status.couldNotCheck': 'Could not check that listing.',
  'search.category.hotel': 'Hotels',
  'search.category.apartment': 'Apartments',
  'search.category.holidayHome': 'Vacation homes',
  'search.category.villa': 'Villas',
  'search.category.guesthouse': 'Guesthouses',
  'search.category.bnb': 'Bed and breakfasts',
  'search.category.hostel': 'Hostels',
  'search.category.resort': 'Resorts',
  'search.category.chalet': 'Chalets',
  'search.category.campground': 'Campgrounds',

  // Options page
  'options.title': 'ListingProof settings',
  'options.tagline': 'Checks an accommodation listing for contradictions on the page itself.',
  'options.sites.heading': 'Checked sites',
  'options.sites.hint':
    'Booking.com and Airbnb are checked out of the box. Add any other booking site here — if its pages carry standard listing markup (schema.org lodging data), ListingProof can check them too. Adding a site asks the browser to allow ListingProof on that site only.',
  'options.sites.inputPlaceholder': 'hotel-site.com — or paste a listing address',
  'options.sites.inputAriaLabel': 'Site to add',
  'options.sites.addButton': 'Add site',
  'options.sites.addInvalid': 'That does not look like a site address.',
  'options.sites.addCovered': '{host} is already checked out of the box.',
  'options.sites.addExists': '{host} is already on the list.',
  'options.sites.addDenied': 'The browser permission for {host} was not granted.',
  'options.sites.addFailed': 'Could not enable checking on {host}.',
  'options.sites.builtinRow': 'Booking.com and Airbnb — built in',
  'options.sites.removeButton': 'Remove',
  'options.sites.removed': 'Stopped checking {host}.',
  'options.sites.added': 'ListingProof now checks {host}.',
  'options.llm.heading': 'Local model (optional)',
  'options.llm.hintBefore': 'With',
  'options.llm.hintAfter':
    "installed, ListingProof also reads the listing's description and reviews locally — nothing leaves your machine. See the setup notes in the project's",
  'options.llm.hintEnd': 'for the one required environment variable.',
  'options.llm.endpointLabel': 'Ollama address',
  'options.llm.modelLabel': 'Model (empty = pick automatically)',
  'options.language.machineNote':
    'Translations are machine-made (Google Translate); English is the original.',
  'options.saveButton': 'Save settings',
  'options.settings.saved': 'Saved.',
  'options.settings.savedNoAccess':
    'Saved — but the browser did not allow access to {endpoint}, so the local model will stay unreachable.',
  'options.settings.saveFailed': 'Could not save settings.',

  // Side panel chrome
  'panel.idle': 'Open an accommodation listing to check it.',
  'panel.noResult': 'No result.',
  'panel.phase.extracting': 'Reading the listing…',
  'panel.phase.checking': 'Running checks…',
  'panel.error.label': 'Check failed',
  'panel.error.fallback': 'Something went wrong.',
  'panel.verdict.red.label': 'Signs of tampering',
  'panel.verdict.red.sub': 'This listing contradicts itself. Verify before booking.',
  'panel.verdict.yellow.label': 'Worth a closer look',
  'panel.verdict.yellow.sub': 'Something here is inconsistent, but it has an innocent explanation too.',
  'panel.verdict.green.label': 'No contradictions found',
  'panel.verdict.green.sub':
    'The checks that could run all passed. That is not a guarantee of legitimacy.',
  'panel.verdict.green.subWithCoverage':
    '{ran} of {total} checks ran on this page and none found a contradiction. That is not a guarantee of legitimacy.',
  'panel.verdict.gray.label': 'Not enough to judge',
  'panel.verdict.gray.sub': 'There was too little verifiable data to reach a conclusion either way.',
  'panel.section.why': 'Why',
  'panel.section.evidence': 'Evidence',
  'panel.section.notChecked': 'Not checked',
  'panel.section.beforeYouBook': 'Before you book',
  'panel.evidence.noneFired': 'No rule fired. Every check that could run found nothing.',
  'panel.coverage.status.notApplicable': 'Not applicable on this platform',
  'panel.coverage.status.noData': 'No data on this page',
  'panel.coverage.status.ran': 'ran',
  'panel.signal.ruleTooltip': 'Rule {id} (engine {engine})',
  'panel.llm.unreachable':
    'Optional extra check: with Ollama running locally, a model on your own machine reads the description and reviews for contradictions. It is not responding — it may not be installed, not running, or not yet allowed to accept requests from extensions. Everything above was checked without it.',
  'panel.llm.noModel':
    'Optional extra check: Ollama is running but has no usable model installed. Pull one (for example llama3.1:8b) to enable it. Everything above was checked without it.',
  'panel.llm.setupLink': 'Set up Ollama',
  'panel.llm.browseModelsLink': 'Browse models',
  'panel.llm.pending': 'Local language-model checks still running; the verdict may sharpen.',
  'panel.llm.capped':
    'A local language-model check flagged something, shown above but not counted towards the verdict: no deterministic rule agreed with it. The model reads the description and guest reviews — text written by other people — so it is allowed to point things out, never to decide.',
  'panel.terms.nothingFlagged': 'The booking terms this page states raised nothing to flag.',
  'panel.terms.label.parking': 'parking',
  'panel.terms.label.cancellation': 'cancellation policy',
  'panel.terms.label.payment': 'payment method',
  'panel.terms.couldNotCheck': 'Could not check: {list} — the page did not state it readably.',
  'panel.terms.pageSays': 'The page says: “{quote}”',
} as const;

export const en = {
  ...uiMessages,
  ...engineaMessages,
  ...enginelMessages,
  ...reviewsMessages,
  ...scoreMessages,
  ...termsMessages,
} as const;
