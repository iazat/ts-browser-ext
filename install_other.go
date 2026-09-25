// Copyright (c) Tailscale Inc & AUTHORS
// SPDX-License-Identifier: BSD-3-Clause

//go:build !windows

package main

// registerHost does nothing outside Windows: there the browser finds the
// manifest by its name in a directory it already searches.
func registerHost(browserByte, name, manifestPath string) (string, error) {
	return "", nil
}

// unregisterHost does nothing outside Windows; see registerHost.
func unregisterHost(browserByte, name string) (string, error) {
	return "", nil
}
