# ListingProof — Privacy Policy

_Last updated: 15 August 2026_

## The short version

ListingProof does not collect, transmit or sell your personal data. It has no
analytics, no accounts, no advertising and no server of its own. It does not
keep a record of the listings you look at.

## What the extension does

When you open a supported accommodation listing, ListingProof reads the page
that is already open in your browser and checks it for internal contradictions.
It shows the result in the side panel.

As of August 2026 the extension no longer compares a listing against archived
copies of itself, and no longer downloads or fingerprints listing photos. Those
checks are gone, and with them three archive services and two image CDNs the
extension used to contact, and two of the things it used to store. This policy
is shorter than the version it replaces for that reason.

The extension's own map page can also search an area on Booking and check one of
those results without you opening it. In that case the page being analysed is
one the extension fetched on your behalf rather than one you opened yourself;
everything after that — the checks, and the outside lookups they make — is the
same either way.

## What is processed, and where

Everything is processed **on your own computer**, inside the extension. There is
no ListingProof server, so there is nowhere for your data to be sent.

To perform its checks the extension makes requests to these third-party
services, and only these:

| Service | What is sent | Why |
|---|---|---|
| `nominatim.openstreetmap.org` | The address and nearby landmark names printed on the listing page | To check that the claimed location and the claimed landmarks are actually near each other |
| `localhost:11434` | Listing description and review text | **Optional.** Only if you have installed Ollama yourself. This is software running on your own machine; nothing leaves your computer |
| `booking.com` (map search) | The search you built: the area you drew (as a centre point and a radius), your dates, guests and rooms, any property-type filter you ticked, and your chosen interface language (so Booking answers in it). Only when you press Search on the map page | To fetch the one page of results you asked for. Sorting happens here afterwards, so no ordering preference is sent. Nothing runs in the background |
| `booking.com` (checking one result) | The address of the single result you picked — pressing "Check this listing" on it, in the results list or in its pin on the map | To fetch that one property page and analyse it here, so you can check a result without opening it. One page fetched from Booking per click, nothing in the background — but the analysis that follows is the full one, so it can also make the geocoding requests in the first row |
| `tile.openstreetmap.org` | The coordinates of the map area you are viewing, as tile requests — only while the map page is open | To draw the map itself |

These requests reveal to those services that *somebody* looked up a particular
listing or place name. They do not carry your identity, your browsing history,
or any account information — the extension has none of these to send. Each
service's own privacy policy governs what it logs.

The two `booking.com` requests are the deliberate exception. They are sent with
the booking.com cookies your browser already holds, so if you are signed in to
Booking they arrive as your own session — exactly as if you had run that search
or opened that property page in a tab yourself. For the search page we tested
this: fetched without those cookies, Booking answers a bot challenge instead of
results, every time. The property page is fetched the same way because it sits
behind the same defences and because the point is to analyse the page you would
have been shown; we have not established that Booking would refuse it without
cookies. The extension has no access to the cookies themselves: the browser
attaches them, and neither the cookies nor the fetched page are stored.

Both requests happen only on an explicit click — pressing Search, or clicking a
result's name — and each click sends exactly one request to booking.com. That
is not the whole story for a check, though: analysing a result runs the same
checks as a listing you opened yourself, so a single click can also produce
geocoding requests to `nominatim.openstreetmap.org`. The search itself makes
none of those.

## What is stored

Stored permanently on your device, in extension-local storage:

- **Geocoding results** — a place name and its coordinates. Cached forever
  because landmarks do not move.
- **Your settings** — the options you chose: interface language, the local
  model address and name, and the map page's last-used search preferences
  (dates, guests, rooms, property categories, sort order). Any extra sites you
  granted are held by the browser itself, as permissions you can revoke there.
  Configuration only: no coordinates, no drawn area and no list of past searches
  are kept, and a check-in date that has already passed is dropped when the
  settings are read.

Nothing is stored temporarily. The 7-day cache of archive lookups was removed
along with the archive check.

**Not stored, ever:** a history of listings you viewed, the areas you searched
on the map, your verdicts, page contents, screenshots, personal details, or
anything identifying you or your device. The analysis result for a tab lives in
memory only and is discarded when that tab navigates elsewhere or you close it.

This is a deliberate design decision rather than an omission. A tool you install
*because* you distrust a listing would, if it kept a visit log, become a record
of every listing you distrusted. We chose not to create that record.

You can erase everything the extension has stored at any time by removing the
extension, or via your browser's "clear data" controls for it.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| Access to supported listing sites | To read the listing you are viewing — and, from the map page, to fetch one page of search results and any single result you ask it to check. This is the entire function of the extension |
| `storage` | To cache geocodes locally, and to keep your settings |
| `sidePanel` | To show the verdict |
| `offscreen` | To parse the one kind of HTML the extension fetches itself — a listing page you asked it to check from the map page — safely, away from any live page |
| Access to the OpenStreetMap and localhost hosts above | To make the checks described above |

The extension does **not** ask for the `tabs` permission, which your browser
describes as "read your browsing history". It shows the verdict for the tab you
are looking at by following that tab's *number*, which needs no permission, and
it learns that a page has gone by the page's own connection to the extension
ending — never by reading the address of a tab. It cannot see the addresses of
your other tabs, and it cannot see where a tab goes when it leaves one of the
listing sites listed above.

## Children

ListingProof is not directed at children and collects no data from anyone.

## Changes

If this policy changes, the updated version will be published with the extension
and the date above will change.

## Contact

Questions or a privacy concern: open an issue on the project's repository.
