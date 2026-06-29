# Tailscale Browser Extension

[![status: experimental](https://img.shields.io/badge/status-experimental-blue)](https://tailscale.com/kb/1167/release-stages/#experimental)

Access your [Tailscale](https://tailscale.com/) tailnet straight from your
browser — **no system-wide Tailscale install, no root/admin, no changes to your
OS VPN or routing tables**. Each browser profile gets its own tailnet, so you
can keep work and personal tailnets fully separate.

> Based on [Tailscale's `ts-browser-ext` experiment](https://github.com/tailscale/ts-browser-ext),
> reworked with 🖤 by [iazat](https://github.com/iazat) — fixed Chrome on macOS
> and added a full management UI (exit nodes, machine list, login/logout).

## What this fork adds

- ✅ **Working login on Chrome / macOS** — the original "Log in" link was a
  dead anchor; it now opens the auth flow correctly.
- 🔀 **Exit node picker** — choose a per-profile exit node right from the popup,
  or clear it. Routes only this browser profile through the exit node.
- 🖥️ **Management page** at `http://100.100.100.100/` — device status, your
  tailnet machine list (with addresses, OS, online state), exit node selector,
  and a **Log out** button. No need to remove/re-add the extension to log out.
- ⏳ **Honest connection states** — "Connecting…" / "Waiting for approval…"
  while Tailscale brings the link up, instead of a scary error flash.
- 🩹 Misc fixes: correct Chrome-vs-Firefox detection during install, the
  missing `need-install` icon, and live popup refresh after login.

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

| Browser | OS      | Status                              |
| ------- | ------- | ----------------------------------- |
| Chrome  | macOS   | **Works**                           |
| Chrome  | Linux   | Works in theory, untested           |
| Chrome  | Windows | Registry install not yet done       |
| Firefox | macOS   | Mostly works                        |
| Firefox | Linux   | Mostly works in theory, untested    |
| Firefox | Windows | Registry install not yet done       |
| Safari  | \*      | Not possible (no Native Messaging)  |

This is still **experimental** and aimed at developers, not end users.

## Requirements

- [Go](https://go.dev/dl/) (the version in [`go.mod`](go.mod) or newer) to build
  and register the native backend.
- Chrome or Firefox.

## Install (Chrome)

1. Open `chrome://extensions`, toggle **Developer mode** on.
2. Click **Load unpacked** and select this repository's directory.
3. Pin the extension and click its icon.
4. The popup prints a `go run … --install=C<extension-id>` command. From this
   repo's directory, run it to build and register the native backend — using
   `go run .` so it installs **your local copy**:

   ```sh
   go run . --install=C<extension-id>
   ```

   (Copy the exact `--install=C…` value from the popup; the `C` prefix means
   Chrome.)
5. Reload the extension, click the icon again, and select **Log in**.

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** and
   pick `firefox/manifest.json`.
2. In `about:addons`, under the extension's **Run in Private Windows**, choose
   **Allow** if you want it active in private browsing.
3. Pin the extension, click its icon, and run the printed
   `go run . --install=F…` command from this repo.
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

## License

BSD 3-Clause — see [LICENSE](LICENSE). Original code © Tailscale Inc & AUTHORS;
see [PATENTS](PATENTS).
