// Copyright (c) Tailscale Inc & AUTHORS
// SPDX-License-Identifier: BSD-3-Clause

//go:build windows

package main

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

// hostRegistryKey is where the browser looks up a native messaging host on
// Windows, under HKEY_CURRENT_USER. The key's default value is the path to
// the host's manifest.
func hostRegistryKey(browserByte, name string) string {
	if browserByte == "F" {
		return `Software\Mozilla\NativeMessagingHosts\` + name
	}
	return `Software\Google\Chrome\NativeMessagingHosts\` + name
}

// registerHost points the browser at the manifest at manifestPath, and
// returns the key it wrote.
func registerHost(browserByte, name, manifestPath string) (string, error) {
	path := hostRegistryKey(browserByte, name)
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return "", err
	}
	defer k.Close()
	if err := k.SetStringValue("", manifestPath); err != nil {
		return "", err
	}
	return `HKCU\` + path, nil
}

// unregisterHost removes the key registerHost wrote, and returns it, or ""
// if there was nothing to remove.
func unregisterHost(browserByte, name string) (string, error) {
	path := hostRegistryKey(browserByte, name)
	err := registry.DeleteKey(registry.CURRENT_USER, path)
	if errors.Is(err, registry.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return `HKCU\` + path, nil
}
