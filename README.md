# TailExt

[![status: experimental](https://img.shields.io/badge/status-experimental-blue)](https://tailscale.com/kb/1167/release-stages/#experimental)

Access your [Tailscale](https://tailscale.com/) tailnet straight from your
browser — **no system-wide Tailscale install, no root/admin, no changes to your
OS VPN or routing tables**. Each browser profile gets its own tailnet, so you
can keep work and personal tailnets fully separate.

> Based on [Tailscale's `ts-browser-ext` experiment](https://github.com/tailscale/ts-browser-ext),
> reworked with 🖤 by [iazat](https://github.com/iazat) — fixed Chrome on macOS
> and added a full management UI (exit nodes, machine list, login/logout).

## What this fork adds

- 🔀 **Exit node picker** — choose a per-profile exit node right from the popup,
  or clear it. Routes only this browser profile through the exit node.
- 🖥️ **Management page** at `http://100.100.100.100/` — device status, your
  tailnet machine list (with addresses, OS, online state), exit node selector,
  and a **Log out** button. No need to remove/re-add the extension to log out.
- ⏳ **Honest connection states** — "Connecting…" / "Waiting for approval…"
  while Tailscale brings the link up, instead of a scary error flash.
- 🦊 **Firefox parity** — the `firefox/` copy carries the same popup, exit node
  picker and proxy handling as the Chrome one.
- 🔒 **No third-party requests** — the popup's font is bundled rather than
  pulled from Google Fonts, so opening it reports to nobody and it still
  renders correctly offline, which for a VPN extension is a state you end up
  in on purpose.
- 🧪 **Tests and CI** — both extensions have suites that run on every change,
  alongside builds for six platforms.

## Fixed here

Most of these predate the fork:

- **The extension hung after its backend restarted.** Every native host is a
  fresh process that has to be sent `init`, and the flag that stops `init`
  being sent twice survived the host dying — so the replacement never started
  tsnet, the popup read "Connecting…" for good, and every page failed until
  the extension was reloaded. Firefox never even reconnected, because it read
  the disconnect reason from Chrome's `runtime.lastError` instead of
  `port.error`.
- **One failed command killed the whole proxy.** The backend's message loop
  exited on any handler error — an `up` that arrived before `init`, an
  `EditPrefs` that missed its deadline while the backend was busy — taking the
  proxy the browser was pointed at with it.
- **Concurrent replies corrupted the native messaging stream.** The frame
  length was staged in a field shared with the reader and written separately
  from its body, so two replies at once could put one message's length in
  front of the other's. The browser then either dropped the connection or
  waited for bytes that never came: a popup stuck on its last state, a toggle
  that did nothing.
- **A lagging IPN bus watcher stopped the backend for good.** Tailscale closes
  a watcher that falls 128 notifications behind, and this one did two LocalAPI
  calls per notification on the watcher's own goroutine. Once closed, the
  status read "WatchIPNBus stopped" until the browser was restarted. It
  resubscribes now, and status messages are built off the watcher's goroutine
  and coalesced.
- **A tab left on the management page could start the wrong node.** Its
  auto-refresh hit the backend before `init`, and `tsnet.Server.LocalClient`
  starts the server if it is not running — with no hostname or state
  directory set. `init` then failed with "already running".
- **Pages loaded right after startup failed instead of waiting.** The browser
  is pointed at the proxy before `init` is even received; dials now wait for
  the backend (up to 20 s) rather than failing on the spot, and CONNECT dials
  have a deadline (30 s) so an exit node that has gone quiet cannot leave a
  tab spinning indefinitely.
- **Nothing brought the extension back after the machine slept.** Sleep
  discards the service worker and the native host with it, and a timer set
  by the worker dies too. The retry is now also held by the browser: a
  one-minute alarm and the idle state flipping back to active both reconnect
  a dead port, and so does opening the popup. Both manifests gained the
  `alarms` and `idle` permissions, so reloading the extension is part of the
  upgrade.
- **A restart switched the tailnet back on, and forgot the exit node.** The
  backend now remembers both the toggle and the exit node beside its state
  and restores them right after start; the extension routes the browser on
  the backend's first status rather than on sight, so off stays off. A
  toggle flipped while the backend is away is delivered to the one that
  arrives.
- **The popup spent a restart blank.** It paints the last known status from
  storage at once, under a spinner, until the background confirms it.
- **The exit node reset to None on every restart.** tsnet starts the backend
  with a fresh set of preferences, and Tailscale takes that as the whole set,
  so every browser start and every reload of the extension silently dropped
  the exit node while traffic left through this machine. The choice is now
  kept beside the profile's state and put back right after start, before the
  browser is allowed to dial.
- **The connect toggle only worked once.** Turning the extension off left the
  browser on a direct connection, and turning it back on never restored the
  proxy — the only way back was reloading the extension.
- **Firefox leaked a dead proxy handler** on every disconnect, pointing at a
  port that was no longer listening, and stacked another one on every
  reconnect.
- **Login was a dead anchor on Chrome / macOS.** It opens the auth flow now.
- **The exit node picker never hid itself**, leaving an empty dropdown on
  screen whenever there was nothing to pick.
- **The install command installed upstream's backend**, which has no exit node
  support — so the picker never appeared and none of the proxy fixes were
  there, with nothing on screen to explain why.
- **The native binary did not compile for Windows at all**, because
  `log/syslog` does not exist there.
- Misc: Chrome-vs-Firefox detection during install, the missing
  `need-install` icon, and live popup refresh after login.

## How it works

Ideally this would be pure WASM/WASI, but browser extensions don't expose
enough APIs, so it uses **Native Messaging**
([Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[Firefox](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)):
a small native binary built on [`tsnet`](https://tailscale.com/kb/1244/tsnet)
runs as a child process of the browser and exchanges JSON messages with the
extension.

That child process runs an HTTP/SOCKS5 proxy on `localhost:0` (the kernel picks
a free port). The extension points the browser's proxy settings at it, so all
web traffic for that profile flows over Tailscale — direct, via an exit node, or
out to the Internet as normal.

The management page at `http://100.100.100.100/` is served by the same child
process over that proxy (so it needs no extra authentication — both ends are
local and trusted).

## Status

| Browser | OS      | Status                                          |
| ------- | ------- | ----------------------------------------------- |
| Chrome  | macOS   | **Works** — exercised before each release        |
| Chrome  | Linux   | Should work; untested                            |
| Chrome  | Windows | Backend builds, but cannot register itself       |
| Firefox | macOS   | Passes its tests; not yet run in a real Firefox  |
| Firefox | Linux   | Same, and the platform is untested too           |
| Firefox | Windows | Backend builds, but cannot register itself       |
| Safari  | \*      | Not possible (no Native Messaging)               |

This is still **experimental** and aimed at developers, not end users.

Two caveats worth stating plainly:

**Firefox.** The `firefox/` copy was substantially rewritten to catch up with
the Chrome one. It passes the same test suites and its popup is byte-identical,
but no build of it has been loaded through `about:debugging` since that rework —
and two of the bugs fixed in it were found by reading the code, not by the
tests. Treat it as untried.

**Windows.** The native binary compiles, but `--install` has no code path for
it: registering a native messaging host on Windows means writing registry keys,
and that is not implemented. Use macOS or Linux.

## Requirements

- [Go](https://go.dev/dl/) (the version in [`go.mod`](go.mod) or newer). The
  native backend is always built on your own machine, including when you
  install the extension from a release.
- Chrome or Firefox, on macOS or Linux.

## Getting the extension files

Either download a packaged build from
[Releases](https://github.com/iazat/ts-browser-ext/releases) and unzip it —
`ts-browser-ext-chrome-*.zip` or `ts-browser-ext-firefox-*.zip`, whichever
browser you use — or clone this repository, whose root doubles as the Chrome
extension directory with the Firefox one under `firefox/`.

The release zips carry only what the browser needs. A clone also carries the
Go sources, tests and CI config, which load harmlessly but are just noise.

## Install (Chrome)

1. Open `chrome://extensions`, toggle **Developer mode** on.
2. Click **Load unpacked** and select the unzipped release directory, or this
   repository's root.
3. Pin the extension and click its icon.
4. The popup prints the exact command to build and register the native
   backend. Copy it verbatim — it carries your extension's own ID, and the
   `C` prefix means Chrome:

   ```sh
   go run github.com/iazat/ts-browser-ext@latest --install=C<extension-id>
   ```

   Working from a clone instead? Use `go run . --install=C<extension-id>` so
   it registers **your local build** rather than the last release.
5. Reload the extension, click the icon again, and select **Log in**.

## Install (Firefox)

Requires Firefox 109 or newer — the manifest is v3, which older builds do not
support.

1. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** and
   pick the `manifest.json` from the unzipped Firefox release, or
   `firefox/manifest.json` in a clone.
2. In `about:addons`, under the extension's **Run in Private Windows**, choose
   **Allow** if you want it active in private browsing.
3. Pin the extension, click its icon, and run the printed
   `--install=F…` command (or `go run . --install=F…` from a clone).
4. Reload and select **Log in**.

> Temporary add-ons are removed when Firefox restarts, so reload it from
> `about:debugging` each session.

## Usage

- **Connect / disconnect:** the toggle in the popup.
- **Exit node:** the dropdown in the popup, or on the management page.
- **Management page:** the **Settings** button opens `http://100.100.100.100/`.
  It is served through the extension's proxy, so it is only there while the
  extension is switched on. With it off, the browser is on a direct
  connection, and on a machine that also runs the Tailscale app that address
  answers with the app's own page instead.
- **Log out:** the **Log out** button on the management page.

## Uninstall the native backend

```sh
go run . --uninstall
```

## Tests

The Go side:

```sh
go test ./...
```

The extensions, which are checked as two separate targets because Chrome and
Firefox are maintained as separate copies of the same files:

```sh
npm ci
npx playwright install chromium
npm test
```

`tests/background.test.mjs` runs both background scripts against a mocked
WebExtension API — proxy lifecycle, the commands the popup sends, the
messages that reach the native host, and what happens when the host goes away
(reconnect with backoff, a fresh `init` for its replacement). `tests/popup.test.mjs` renders both
popups in Chromium and drives them through their states. The popup suite runs
in Chromium even for the Firefox copy: the markup, CSS and `popup.js` logic
are shared, so that is what it covers. Firefox's `proxy.onRequest` and
native-messaging integration still needs a real Firefox via
`about:debugging`.

If you have a Chromium that playwright didn't install, point at it with
`CHROMIUM_PATH=/path/to/chromium npm test`.

One more suite is run by hand, not by `npm test`:

```sh
npm run test:e2e
```

`tests/e2e-chromium.mjs` builds the Go backend, loads the real Chrome
extension into a real Chromium, registers the backend for it the way
`--install` does, and then kills the backend with SIGKILL and checks that the
extension recovers on its own: a replacement is started and sent `init`, the
popup says it is reconnecting meanwhile, the browser's proxy is re-pointed at
the new port, and exactly one backend is left running. It needs Linux paths
and takes about ten seconds; `EXT_DIR` and `HOST_BIN` point it at another
build, which is how the pre-fix behaviour was confirmed against the same
script.

## Releases

Tags are `vX.Y.Z` — Go requires the `v` and all three components to resolve
`@latest`. The `version` field in the two manifests should be bumped to match
before tagging. (`v1.1.0` shipped manifests reading `1.1`; both forms are valid
to a browser, but keeping them identical avoids having to work out which build
someone is running.)

Pushing a tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which re-runs the whole check suite — it does not assume the tagged commit went
through a pull request, since a tag can be pushed anywhere — then packages both
extensions and publishes a GitHub release with the zips attached. If a release
for that tag already exists, it uploads into it and leaves the existing title
and notes alone.

Release notes come from `docs/release-notes/<tag>.md`, so write that file
before tagging; without it the workflow falls back to a generated changelog.

Cutting a release:

1. Bump `version` in `manifest.json` and `firefox/manifest.json`.
2. Add `docs/release-notes/vX.Y.Z.md`.
3. Merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`.

Or, without pushing a tag: run the Release workflow by hand from the Actions
tab (or `gh workflow run release.yml -f version=X.Y.Z`). It checks the version
against both manifests, runs the same checks, creates the tag on the commit it
verified, and publishes.

To build the packages yourself:

```sh
script/package.sh          # version read from manifest.json
```

Two more generators, both needing `npm ci` first:

```sh
npm run icons              # every icon, for both extensions, from one palette
npm run screenshots        # store listing screenshots into dist/screenshots/
```

`npm run icons` also rewrites the mark embedded in both popups, so the artwork
cannot drift between the files and the markup. Running it twice changes
nothing.

They land in `dist/`. The script lists the shipped files explicitly instead of
filtering the repository, so a missing one fails the build rather than
producing a half-working extension. The zips are byte-reproducible: timestamps
are flattened, the extra attribute blocks dropped, and the entries sorted, so
a build of a tagged commit has the same checksum as the asset published for
that tag — on any machine, not just the one that built it twice. The script
checks the ordering and fails rather than publishing an archive that lost it.

## License

BSD 3-Clause — see [LICENSE](LICENSE). Original code © Tailscale Inc & AUTHORS;
see [PATENTS](PATENTS).

Bundled Inter font: SIL Open Font License 1.1 — see
[fonts/LICENSE.txt](fonts/LICENSE.txt).

Privacy: [PRIVACY.md](PRIVACY.md). Notes for a Chrome Web Store submission:
[docs/chrome-web-store.md](docs/chrome-web-store.md).
