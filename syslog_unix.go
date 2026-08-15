// Copyright (c) Tailscale Inc & AUTHORS
// SPDX-License-Identifier: BSD-3-Clause

//go:build unix

package main

import (
	"io"
	"log/syslog"
)

// dialDebugSyslog connects to a syslog daemon listening on localhost, so that
// log output can be watched while the process runs as a child of the browser
// with its stdout and stderr spoken for by the native messaging protocol.
//
// Failing to connect is the normal case and is not an error worth acting on.
func dialDebugSyslog() (io.Writer, error) {
	return syslog.Dial("tcp", "localhost:5555", syslog.LOG_INFO, "browser")
}
