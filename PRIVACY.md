# Privacy policy

_TailExt browser extension. Last updated: August 2026._

## What this extension collects: nothing

TailExt does not collect, transmit, or sell any personal information. It has no
analytics, no telemetry, and no servers of its own — there is no infrastructure
belonging to this project for anything to be sent to.

## What it stores

One value: a randomly generated profile identifier, kept in the browser's local
extension storage. It exists so that this browser profile keeps a consistent
tailnet identity between restarts. It contains nothing derived from you or from
your browsing, and it never leaves your machine.

## What it does with your traffic

When you switch it on, the extension points this browser profile's proxy
settings at a local proxy, run by a companion application on your own computer.
Your traffic then travels over your own Tailscale tailnet, under your own
Tailscale account, subject to [Tailscale's privacy
policy](https://tailscale.com/privacy-policy).

The extension itself does not inspect, log, or retain any of it. When you switch
the extension off, the browser is returned to a direct connection.

## Page content

The extension has no content scripts. It does not read, modify, or inject
anything into the pages you visit. Its `<all_urls>` permission exists because
proxy settings apply to every request a browser makes, not because it looks at
them.

## The companion application

The native backend runs on your own machine, as a child process of your browser,
built from the source in this repository. It speaks to Tailscale's coordination
service the same way any Tailscale client does, using credentials you provide by
logging in.

## Third parties

None. The extension makes no requests of its own — the font it uses is bundled
rather than fetched from a content delivery network, so opening the popup
contacts nobody.

## Changes

Any change to this policy will be a commit in this repository, visible in its
history.

## Contact

Questions and reports: https://github.com/iazat/ts-browser-ext/issues
