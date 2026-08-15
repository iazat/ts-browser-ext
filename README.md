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
WebExtension API — proxy lifecycle, the commands the popup sends, and the
messages that reach the native host. `tests/popup.test.mjs` renders both
popups in Chromium and drives them through their states. The popup suite runs
in Chromium even for the Firefox copy: the markup, CSS and `popup.js` logic
are shared, so that is what it covers. Firefox's `proxy.onRequest` and
native-messaging integration still needs a real Firefox via
`about:debugging`.

If you have a Chromium that playwright didn't install, point at it with
`CHROMIUM_PATH=/path/to/chromium npm test`.

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

To build the packages yourself:

```sh
script/package.sh          # version read from manifest.json
```

They land in `dist/`. The script lists the shipped files explicitly instead of
filtering the repository, so a missing one fails the build rather than
producing a half-working extension. The zips are not byte-reproducible — zip
records file timestamps — so rebuilding gives a different checksum for
identical contents.

## License

BSD 3-Clause — see [LICENSE](LICENSE). Original code © Tailscale Inc & AUTHORS;
see [PATENTS](PATENTS).

Bundled Inter font: SIL Open Font License 1.1 — see
[fonts/LICENSE.txt](fonts/LICENSE.txt).
