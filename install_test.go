// Copyright (c) Tailscale Inc & AUTHORS
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
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
