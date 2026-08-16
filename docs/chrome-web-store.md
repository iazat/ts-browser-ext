# Chrome Web Store submission

Everything the store dashboard asks for, written out so it can be pasted in
rather than improvised at submission time.

## Naming and branding

The extension used to ship as "Tailscale Extension", with Tailscale's wordmark
in the popup, their dot-grid icon, and a Firefox add-on id of
`browser-ext@tailscale.com`. None of that could go to the store from an account
that is not Tailscale's:

- The BSD-3 licence this code carries says, in clause 3, that the copyright
  holder's name may not be used to promote derived products "without specific
  prior written permission".
- Store policy separately forbids listings that imply affiliation with someone
  else's product.

It now ships as **TailExt**, with an original icon, and a Firefox add-on id of
`tailext@iazat.github.io`. Tailscale is referred to in the description as the
service this works with, which is fine and normal, and the popup keeps its
attribution link to the upstream project.

One caveat to weigh before submitting: `Tail-` is effectively Tailscale's own
prefix (tailnet, tailscaled, Tailscale SSH), so "TailExt" still reads as a
contraction of "Tailscale Extension". It is a much smaller problem than
shipping their wordmark, but it is not zero — trademark questions turn on
whether people are likely to assume an affiliation.

Two things found when checking, neither conclusive:

- No extension named "TailExt" is listed in the store.
- [Tailchrome](https://chromewebstore.google.com/detail/tailchrome/bhfeceecialgilpedkoflminjgcjljll)
  is listed, does much the same thing, and carries the same prefix — so a
  third-party Tailscale extension named `Tail…` has already passed review.
  That is precedent, not permission.

A trademark register has not been searched. Do that before the listing goes in.

## Single purpose

Required field. Reviewers reject vague answers.

> Routes this browser profile's traffic through a Tailscale tailnet, using a
> local proxy provided by a companion application, so that each browser profile
> can use a different tailnet without changing the operating system's VPN
> settings.

## Permission justifications

One box per permission. Each answer has to say what breaks without it.

**`proxy`** — the entire function of the extension. The companion application
opens an HTTP/SOCKS5 proxy on a loopback port and reports that port over native
messaging; this permission is what lets the extension point the browser at it,
and hand the browser back to a direct connection when the user switches off.

**`nativeMessaging`** — the extension has no network stack of its own. A
companion application built on Tailscale's `tsnet` library runs as a child
process of the browser and does the actual tailnet networking. This permission
carries the JSON messages between them: connection status, the proxy port, the
selected exit node.

**`storage`** — stores one value, a randomly generated profile identifier, so
that each browser profile keeps its own separate tailnet identity across
restarts. No browsing data is stored.

**`background`** — the connection has to stay up while no popup is open,
and the extension has to notice the companion application going away so it can
return the browser to a direct connection rather than leaving it pointed at a
dead port.

**`host_permissions: <all_urls>`** — proxy settings apply to every request the
browser makes, so the permission has to cover every URL. The extension does not
read, inject into, or modify page content, and has no content scripts.

## Remote code

Answer: **no remote code**.

Everything executed is in the package. The popup's font is bundled rather than
fetched from a CDN, so the extension makes no outbound requests of its own —
worth stating, because a "no remote code" answer contradicted by a network
request is a fast rejection.

## Data usage

Declare only what is true:

- **Not collected:** browsing history, page content, personally identifying
  information, location, financial data, health data, authentication
  information. The extension does not read page content and has no content
  scripts.
- **Stored locally:** a randomly generated profile identifier, in
  `chrome.storage.local`. It never leaves the machine.
- **Not sold, not transferred to third parties, not used for advertising or
  credit scoring.**

Traffic does traverse the user's own tailnet once connected, which is the
point of the product rather than data collection by this extension. Say so
plainly in the privacy policy instead of leaving reviewers to work it out.

## Companion software disclosure

The store requires disclosing software the extension depends on. Do not bury
this — a reviewer who installs the extension and finds it inert will reject it.

> This extension requires a companion application on the same machine. It does
> nothing on its own. After installing, open the popup: it prints a single
> command that builds and registers the companion from source. Building it
> requires the Go toolchain, and only macOS and Linux are supported. The source
> is at https://github.com/iazat/ts-browser-ext.

## Privacy policy

The store requires a hosted URL. [`PRIVACY.md`](../PRIVACY.md) in the repository
root serves as one — GitHub renders it at a stable address. The text below is
kept here only so the reasoning behind each claim stays next to the rest of the
submission notes; `PRIVACY.md` is the copy that gets linked.

> **What this extension collects: nothing.**
>
> TailExt does not collect, transmit, or sell any personal information. It has
> no analytics, no telemetry, and no servers of its own.
>
> **What it stores.** A single randomly generated identifier, kept in the
> browser's local extension storage, so that this browser profile keeps a
> consistent tailnet identity between restarts. It contains nothing derived
> from you or your browsing, and never leaves your machine.
>
> **What it does with your traffic.** When you switch it on, the extension
> points this browser profile's proxy settings at a local proxy run by the
> companion application on your own computer. Your traffic then travels over
> your own Tailscale tailnet, under your own account, subject to
> [Tailscale's privacy policy](https://tailscale.com/privacy-policy). Nothing
> is routed through any infrastructure belonging to this project's authors,
> because this project has none.
>
> **Page content.** The extension has no content scripts and does not read,
> modify, or inject anything into the pages you visit.
>
> **Contact.** https://github.com/iazat/ts-browser-ext/issues

## Listing copy

**Short description** (132 characters max):

> Give each browser profile its own Tailscale tailnet, without touching your
> system VPN settings. Unofficial, open source.

**Full description:**

> TailExt lets a single browser use several Tailscale tailnets at once — one per
> browser profile — without installing a system-wide VPN client, without
> administrator rights, and without changing your operating system's networking
> or routing.
>
> Each profile connects independently. Work in one window, personal in another.
>
> **Features**
> • Connect and disconnect from the popup
> • Pick an exit node per profile, or none
> • Management page with your tailnet's machines, their addresses and status
> • Log out without removing the extension
>
> **Requirements**
> This extension needs a small companion application on your own machine; it
> does nothing by itself. The popup shows you the one command that installs it.
> Building it requires the Go toolchain. macOS and Linux only — Windows is not
> supported yet.
>
> **Unofficial**
> Not affiliated with or endorsed by Tailscale Inc. Built on Tailscale's open
> source `ts-browser-ext` experiment and their `tsnet` library. You will need
> your own Tailscale account.
>
> Source code and issue tracker: https://github.com/iazat/ts-browser-ext

## Assets checklist

| Item | Requirement | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | `icons/icon128.png` |
| Extension icons | 16/32/48/128 in `manifest.json` | declared |
| Screenshots | at least one, 1280×800 or 640×400 | `npm run screenshots` → `dist/screenshots/` |
| Small promo tile | 440×280, optional | optional |
| Privacy policy URL | must be publicly reachable | [`PRIVACY.md`](../PRIVACY.md) |
| Developer account | one-off 5 USD registration | account holder's step |

## Expect a slow review

`<all_urls>` together with `proxy` and `nativeMessaging` is about as broad as an
extension can ask for, and dependence on locally built companion software is
unusual. Both draw manual review. Answer the justification boxes fully the
first time; a rejection costs another full review cycle.
