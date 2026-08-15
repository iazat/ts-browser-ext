// Copyright (c) Tailscale Inc & AUTHORS
// SPDX-License-Identifier: BSD-3-Clause

//go:build !unix

package main

import (
	"errors"
	"io"
)

// dialDebugSyslog is unavailable here: log/syslog is not implemented on
// Windows, Plan 9 or js/wasm. The caller treats an error as "no syslog", which
// is also the normal outcome on platforms that do have it.
func dialDebugSyslog() (io.Writer, error) {
	return nil, errors.New("syslog is not available on this platform")
}
