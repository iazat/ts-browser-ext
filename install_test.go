// Copyright (c) Tailscale Inc & AUTHORS
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"encoding/json"
	"net/netip"
	"os"
	"regexp"
	"testing"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

// TestFirefoxExtensionIDMatchesManifest guards a mismatch that fails silently.
//
// Firefox will not let an extension talk to a native messaging host unless the
// host's allowed_extensions lists that extension's id. When the two drift, the
// extension still installs and the popup still opens — the backend simply never
// answers, with nothing on screen to say why. Renaming the extension is exactly
// when they drift, because the id lives in the manifest and the check lives
// here in Go.
func TestFirefoxExtensionIDMatchesManifest(t *testing.T) {
	b, err := os.ReadFile("firefox/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		BrowserSpecificSettings struct {
			Gecko struct {
				ID string `json:"id"`
			} `json:"gecko"`
		} `json:"browser_specific_settings"`
	}
	if err := json.Unmarshal(b, &manifest); err != nil {
		t.Fatal(err)
	}

	got := manifest.BrowserSpecificSettings.Gecko.ID
	if got == "" {
		t.Fatal("firefox/manifest.json declares no browser_specific_settings.gecko.id")
	}
	if got != firefoxExtensionID {
		t.Errorf("firefox/manifest.json id is %q, but the installer writes %q into "+
			"allowed_extensions; Firefox would refuse to connect", got, firefoxExtensionID)
	}
}

// TestInstallRejectsBadChromeID keeps the extension ID check honest: it is the
// only validation between a typo in a pasted command and a registration that
// silently belongs to no extension.
func TestInstallRejectsBadChromeID(t *testing.T) {
	for _, arg := range []string{
		"C",                                  // no id at all
		"Cshort",                             // too short
		"CABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF",  // uppercase is not valid
		"C012345678901234567890123456789012", // too long
		"X0123456789012345678901234567890",   // unknown browser byte
	} {
		if err := install(arg); err == nil {
			t.Errorf("install(%q) was accepted; expected it to be rejected", arg)
		}
	}
}

// TestHostNamesMatchExtensions ties the names in this file to the ones the
// extensions actually ask for.
//
// Each background script calls connectNative with a literal string, and the
// browser looks for a registration file named the same. Nothing in either
// language references the other, so a rename touches one side and leaves the
// other — and the failure is invisible: the extension installs, the popup
// opens, the backend is never found. This is how the Firefox add-on id came
// to disagree with its manifest.
func TestHostNamesMatchExtensions(t *testing.T) {
	for _, tt := range []struct {
		file string
		want string
	}{
		{"background.js", chromeHostName},
		{"firefox/background.js", firefoxHostName},
	} {
		b, err := os.ReadFile(tt.file)
		if err != nil {
			t.Fatal(err)
		}
		m := regexp.MustCompile(`connectNative\("([^"]+)"\)`).FindSubmatch(b)
		if m == nil {
			t.Errorf("%s: no connectNative call found", tt.file)
			continue
		}
		if got := string(m[1]); got != tt.want {
			t.Errorf("%s connects to %q, but the installer registers %q; "+
				"the browser would never find the backend", tt.file, got, tt.want)
		}
	}
}

// TestIsConfiguredExitNode covers the distinction the popup was getting wrong:
// a node stays selected while it is not carrying traffic.
func TestIsConfiguredExitNode(t *testing.T) {
	const id = tailcfg.StableNodeID("nodeABC")
	ip := netip.MustParseAddr("100.96.115.109")
	other := netip.MustParseAddr("100.68.174.25")

	for _, tt := range []struct {
		name   string
		peer   *ipnstate.PeerStatus
		prefID tailcfg.StableNodeID
		prefIP netip.Addr
		want   bool
	}{
		{
			// The case that made the picker read None: switched off, so nothing
			// is routing, but the selection is still in the preferences.
			name:   "configured by id while not routing",
			peer:   &ipnstate.PeerStatus{ID: id},
			prefID: id,
			want:   true,
		},
		{
			name:   "configured by ip while not routing",
			peer:   &ipnstate.PeerStatus{TailscaleIPs: []netip.Addr{ip}},
			prefIP: ip,
			want:   true,
		},
		{
			name: "actively routing, preferences unreadable",
			peer: &ipnstate.PeerStatus{ExitNode: true},
			want: true,
		},
		{
			name:   "a different peer entirely",
			peer:   &ipnstate.PeerStatus{ID: "somethingElse", TailscaleIPs: []netip.Addr{other}},
			prefID: id,
			prefIP: ip,
		},
		{
			name: "no exit node configured at all",
			peer: &ipnstate.PeerStatus{ID: id, TailscaleIPs: []netip.Addr{ip}},
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := isConfiguredExitNode(tt.peer, tt.prefID, tt.prefIP); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

// The proxy is listening, and the browser has been pointed at it, before tsnet
// finishes starting. Anything dialed in that window leaves through this
// machine rather than the exit node — which is invisible afterwards, since the
// backend is Running and reporting the right exit node by the time anyone
// looks.
func TestSafeToDial(t *testing.T) {
	for _, tt := range []struct {
		name        string
		state       ipn.State
		exitNodeSet bool
		want        bool
		why         string
	}{
		{
			name:        "starting with an exit node configured",
			state:       ipn.Starting,
			exitNodeSet: true,
			why:         "this is the leak: the tailnet is not carrying traffic yet",
		},
		{
			name:        "no state yet with an exit node configured",
			state:       ipn.NoState,
			exitNodeSet: true,
			why:         "the backend has not reported anything; assume the worst",
		},
		{
			name:        "stopped with an exit node configured",
			state:       ipn.Stopped,
			exitNodeSet: true,
			why:         "nothing is routing, so nothing should leave",
		},
		{
			name:        "running with an exit node configured",
			state:       ipn.Running,
			exitNodeSet: true,
			want:        true,
		},
		{
			name:        "needs login with an exit node configured",
			state:       ipn.NeedsLogin,
			exitNodeSet: true,
			want:        true,
			why:         "the login page is reached through this proxy; refusing locks the user out",
		},
		{
			name:  "starting with no exit node",
			state: ipn.Starting,
			want:  true,
			why:   "without an exit node, leaving through this machine is the point",
		},
		{
			name:  "running with no exit node",
			state: ipn.Running,
			want:  true,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := safeToDial(tt.state, tt.exitNodeSet); got != tt.want {
				t.Errorf("safeToDial(%v, %v) = %v, want %v: %s", tt.state, tt.exitNodeSet, got, tt.want, tt.why)
			}
		})
	}
}
