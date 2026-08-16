# ListingProof

A Chrome extension (MV3) that checks an accommodation listing for signs that its
identity has been tampered with, and shows the evidence behind the verdict.

It works across listing platforms. Booking.com and Airbnb have bespoke adapters;
any other site that publishes standard schema.org lodging markup is read by a
generic adapter with no per-site code.

It is built for the **first visit**: it assumes no prior knowledge of the
listing, keeps no browsing history, and reaches its verdict from the page in
front of you and nothing else.

> **2026-08-15 — the archive-history check (Engine B) and the perceptual photo
> comparison were removed** by product decision. The extension no longer
> compares a listing against older copies of itself, and no longer contacts
> `web.archive.org`, `archive.ph`, `archive.today` or the platforms' image
> CDNs — five host permissions gone, and a shorter install warning. The cost is
> stated plainly rather than buried: a listing quietly relocated or renamed
> months ago, whose page reads consistently today, is not something this
> extension can detect.

## The problem

Listing hijacking takes over an existing accommodation listing that already has
years of genuine reviews, then swaps the name, address and photos. The
reputation stays; the property it referred to is gone.

## How it decides

Two engines propose signals. `lib/score.ts` is the only place they combine.

**Engine A — intra-page consistency.** Works with nothing but the open page,
which is why it now carries the product outright.

- `A1` On platforms whose URLs carry the property name (Booking), the slug is
  fixed at listing creation and survives renames, so it is a fossil of what the
  listing used to be. A slug sharing nothing with the displayed name is
  evidence. Platforms with opaque id URLs (Airbnb's `/rooms/<id>`) have no
  fossil, so A1 declares itself inapplicable rather than inventing a comparison
  — see `SiteCapabilities.nameBearingUrl`.
- `A2` The page prints its own claimed distance to nearby landmarks. Geocode
  them and measure: a page claiming a museum is 250 m away when it is 450 km
  away is contradicting itself.
- `A3` The breadcrumb trail's city versus the coordinates.

**Engine L — local LLM (optional, untrusted).** Entirely optional: with no
Ollama installed the extension is fully functional and no verdict changes — the
panel simply offers the upgrade. Install Ollama, pull a model, and start it with
`OLLAMA_ORIGINS="chrome-extension://*"` so the extension may reach it. When a
model is available it reads
the description and reviews, and is treated as a hostile-influenced source
throughout, because listing text is written by the party being investigated:

- Its findings are **advisory and cannot change the verdict.**
- Its useful output is `L1`, candidate landmark names, which the geocoder then
  verifies — a hallucinated landmark cannot survive that check.
- Every quoted finding must be locatable verbatim in the page text, or it is
  discarded before scoring.
- `fixtures/injection/` holds ten prompt-injection payloads; the test suite
  asserts the verdict is identical with a fully-compromised model.

## Verdicts

`GREEN | YELLOW | RED | GRAY`. GRAY is first-class and means "not enough to
judge" — missing data is never scored as a pass.

## Layout

```
lib/            pure, browser-free, unit-tested
  sites/        THE ONLY PLACE A PLATFORM IS KNOWN ABOUT
    types       the SiteAdapter contract + capability flags
    registry    URL/document → adapter (bespoke first, generic fallback)
    patterns    match patterns, kept in step with the adapters by a test
    booking/    Booking.com: URL, extraction, page context
    airbnb      Airbnb
    generic     any site with schema.org lodging markup
  identity      IdentityVector — platform-independent, what engines consume
  pagecontext   breadcrumbs, POIs, description, reviews (shapes + helpers)
  geo text      distance, name comparison
  enginea enginel score    the rules, and where they combine
background/     everything that touches the network
  geocode       Nominatim (1 req/s, permanent cache)
  pipeline      orchestration: identity in, verdict out
entrypoints/
  listing.content   reads the page, sends it on, does nothing else
  background        the only context that makes network calls
  offscreen         parses the pages the worker fetches itself, for the map
                    search's check-without-opening (MV3 workers have no DOMParser)
  sidepanel         a pure view over the result
```

## Development

```bash
npm run dev
```

Loads the extension into a fresh Chrome with hot reload. To load a production
build manually, run `npm run build` and load `.output/chrome-mv3` unpacked from
`chrome://extensions`.

```bash
npm test
```

Runs the full suite. Fixtures under `fixtures/` are large real pages — do not
open them in an editor or read them into an AI context; interact with them
through the tests.

Regenerate derived fixtures and assets:

```bash
npx vite-node scripts/make-synthetic.ts
```

```bash
npx vite-node scripts/make-injection.ts
```

```bash
npx vite-node scripts/make-icons.ts
```

## Test corpora

- `fixtures/live/` — 13 real Booking.com pages across 10 locales, captured as
  rendered DOM. Two are genuine in-the-wild hijacks, both found by the extension
  while browsing normally: an Alpine slug serving a Paris listing, and a rural
  gite slug serving "Le Grand Paris Apartments". They are the Engine A
  acceptance cases.
- `fixtures/live-airbnb/` — 7 real Airbnb pages across 5 countries (FR, JP, ES,
  IT, BR), held to the same zero-RED budget as the Booking corpus.
- `fixtures/live-generic/` — 2 real hotel-chain pages (Premier Inn, Accor) that
  no bespoke adapter handles. They are the evidence that the generic
  schema.org adapter works on sites nobody wrote code for.
- `fixtures/synthetic/` — 14 compact control pages, one per live fixture: the
  live page's real IdentityVector re-rendered as a page carrying only
  identity-bearing markup. It used to hold 60 mutated pairs (relocation,
  identity swap, legitimate rebrand, review drop, id mismatch) as well; every
  one of those existed to fire a `B.*` archive-diff rule, so they went with the
  engine on 2026-08-15.
- `fixtures/injection/` — 10 prompt-injection payloads for Engine L.

The false-positive budget is enforced in `background/acceptance.test.ts`: zero
REDs across the real corpus. A fraud warning on a legitimate hotel is the
failure that matters most.

## Privacy

No server, no analytics, no accounts, no visit history. Everything is analysed
on your own machine. The extension contacts only the listing site it is
checking, OpenStreetMap's geocoder for the addresses and landmarks the page
names, and — if you installed it — your own local Ollama. It stores geocoding
results and your settings, and nothing about which listings you looked at. The
full policy is in [docs/privacy-policy.md](docs/privacy-policy.md).

## Contributing and publishing

Security reports: open a GitHub issue, or email the address on the Chrome Web
Store listing. The interesting failures here are a false GREEN, a false RED on
an honest listing, and anything that lets the optional local model move a
verdict on its own.

Licensed MIT.

## Adding a platform

Write an adapter in `lib/sites/`, implementing `SiteAdapter` from
`lib/sites/types.ts`. Nothing outside that directory should need to change:
the engines, the scorer and the panel all read `IdentityVector` and know
nothing about who published it.

1. Implement the adapter. Start from `lib/sites/generic.ts` if the site
   publishes schema.org lodging markup — often that plus URL canonicalisation
   is the whole job.
2. Declare its `capabilities` honestly. `nameBearingUrl: false` on a site whose
   URLs are opaque ids is what keeps Engine A1 from comparing a number to a
   name.
3. Register it in `lib/sites/registry.ts` and add its match patterns to
   `lib/sites/patterns.ts`. A test fails if those two disagree.
4. Capture a couple of real pages as fixtures and assert against measured
   values, not against whatever your code currently returns.
