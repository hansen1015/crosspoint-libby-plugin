# CrossPoint Libby plugin (experimental)

A [CrossPoint](https://github.com/crosspoint-reader) e-reader plugin that lets you
pair with Libby, search your library's catalogue, and borrow an ebook from the
e-reader's web page. Getting the book file itself is **not solved yet** (see below).

> **Read this first.** Pairing and borrowing use Libby's private API
> (`sentry.libbyapp.com`). The API's own replies state that use by clients other
> than the Libby app, and reverse engineering of its requests or authorization,
> is prohibited by OverDrive's Terms and Conditions, with possible account
> suspension. This project is unofficial and not affiliated with OverDrive.
> Use it at your own risk, and preferably not with a card you can't afford to
> lose access to. Pull requests that work around Libby's authorization checks
> are out of scope here.

## Status

| Step | Status | Notes |
|---|---|---|
| Install from a catalog | Works | Needs a host the device can download from (see Hosting) |
| Pair with Libby via an 8-digit setup code | Works | The code comes from the Libby app's **Sonos speaker connection** option, not "Copy To Another Device" |
| Read library cards (sync) | Works | |
| Search the library catalogue | Works | Uses `thunder.api.overdrive.com`, results filtered to EPUB (Adobe) |
| Borrow a title | Works | The loan appears on your Libby shelf |
| Get the `.acsm` for the loan | **Does not work** | See below |
| Fulfill `.acsm` and download the EPUB | Works separately | Done by the existing "Protected Content" plugin, not by this one |

### The open problem: getting the `.acsm`

After a borrow, the plugin looks for an Adobe EPUB download for the loan. What was
observed against the live API:

- `chip/sync` returns the loan, with `formats` entries that have **no download or
  fulfill link** (keys seen: `identifiers, rights, fileSize, onSaleDateUtc,
  fulfillmentType, isLockedIn, id, name`, ...).
- `GET /card/{card}/loan/{id}/fulfill/ebook-epub-adobe` on `sentry-read.svc.overdrive.com`
  returns **403 `missing_chip`**; the POST variant returns 404.

So the Libby app does not appear to expose Adobe EPUB downloads through the endpoints
tried here. Where a title offers Adobe EPUB, the official route is the library's own
OverDrive website: log in, open **Loans**, choose **Download EPUB eBook (Adobe)**. That
gives an `.acsm`.

**Workaround that does not need a computer:** download the `.acsm` in your phone's
browser, upload it through the e-reader's File Transfer page into the same SD folder,
then fetch it with the Protected Content plugin.

Open Libby formats seen in search: Kindle, OverDrive Read (streaming only), EPUB
(Adobe), Open EPUB (no Adobe lock, offered for few titles), Kobo.

## Usage

1. Start File Transfer on the e-reader in **Join Network** mode (not Hotspot), and open
   the page it shows from a phone or PC on the same Wi-Fi.
2. In the File Manager, open the folder where books should go.
3. Install the plugin from the catalog, then open **Libby Library**.
4. In the Libby app, use the **Sonos speaker connection** option to get an 8-digit code.
   Enter it in the plugin and tap **Pair with Libby**. Codes expire quickly.
5. Search, pick a title marked "available", tap **Borrow**.
6. Download the `.acsm` from your library website (see above), upload it to the SD
   folder, and use **Protected Content** to fetch it.

If a step fails, open the plugin's **Debug log** (tokens are redacted).

## Things learned about CrossPoint plugins

- `api.relay` has a small response limit. The catalogue search reply is 60-140 KB (mostly
  filter data) and fails with `502: relay failed; large bodies need /api/fetch`. The plugin
  uses `api.fetchToSd` to save it to the SD card, then reads it back via `/download`.
- Installing a plugin from a catalog downloads each file with `/api/fetch`. If the `base`
  URL doesn't resolve you get `Error: /api/fetch made no progress`.
- Hosting: GitHub Pages behind a custom domain broke install until the domain's
  certificate was ready. A commit-pinned jsDelivr URL
  (`https://cdn.jsdelivr.net/gh/<user>/<repo>@<commit>/`) works and never serves a stale
  catalog. See `catalog.json`.
- Plugin state (Libby identity) is stored on the SD card in the plugin folder as
  `libby.json`. Treat it like a password.

## Files

- `manifest.json`, `plugin.js` — the plugin
- `catalog.json` — catalog entry (update `base` to a commit-pinned URL when you release)

## Related projects

- [crosspoint-reader/crosspoint-plugin-hub](https://github.com/crosspoint-reader/crosspoint-plugin-hub) — catalog and installer for CrossPoint plugins
- [ruqqq/crosspoint-plugins](https://github.com/ruqqq/crosspoint-plugins) — another CrossPoint plugin catalog
- [bgschiller/libby-web-fetch](https://github.com/bgschiller/libby-web-fetch), [JavaGT/libby-archiver](https://github.com/JavaGT/libby-archiver) — Libby audiobook download tools (audio, not EPUB/Adobe)

## Ideas / help wanted

- A legitimate way to hand the borrowed loan to the device without a manual download, e.g.
  a button that opens the library's Loans page.
- Whether the library website's Adobe EPUB download can be started from a phone and sent
  straight to the device.
- A companion plugin for DRM-free sources (Project Gutenberg, Standard Ebooks, Internet
  Archive) that downloads straight to the SD card.
