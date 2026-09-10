// Copyright (c) Tailscale Inc & AUTHORS
// SPDX-License-Identifier: BSD-3-Clause

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tailcfg"
)

// frame encodes one native messaging frame the way the browser would send it.
func frame(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]byte, 4+len(b))
	binary.LittleEndian.PutUint32(out, uint32(len(b)))
	copy(out[4:], b)
	return out
}

// decodeFrames splits what the host wrote into replies, failing on anything
// that is not a well-formed frame — which is exactly what the browser would
// choke on.
func decodeFrames(t *testing.T, b []byte) []reply {
	t.Helper()
	var out []reply
	for len(b) > 0 {
		if len(b) < 4 {
			t.Fatalf("trailing %d bytes are not a frame header", len(b))
		}
		n := binary.LittleEndian.Uint32(b)
		b = b[4:]
		if uint32(len(b)) < n {
			t.Fatalf("frame header says %d bytes but only %d follow", n, len(b))
		}
		var r reply
		if err := json.Unmarshal(b[:n], &r); err != nil {
			t.Fatalf("frame is not JSON: %v: %q", err, b[:n])
		}
		out = append(out, r)
		b = b[n:]
	}
	return out
}

// lockedBuffer is a bytes.Buffer that reports interleaved writes, so the
// test below cannot pass by accident of the buffer tolerating them.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func quietHost(r io.Reader, w io.Writer) *host {
	h := newHost(r, w)
	h.logf = func(string, ...any) {}
	return h
}

// The host writes to the browser from several goroutines at once: the reader
// answering a command, the status loop, the management page's handlers. Each
// frame is a length and a body, and the browser reads them back to back. A
// length staged in shared state and written separately from its body let two
// concurrent sends put one message's length in front of the other's body,
// after which the browser was reading a stream that no longer parsed.
func TestSendConcurrentFramesStayWellFormed(t *testing.T) {
	var out lockedBuffer
	h := quietHost(strings.NewReader(""), &out)

	const senders = 32
	const perSender = 50
	var wg sync.WaitGroup
	for i := range senders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range perSender {
				// Vary the sizes so mismatched headers cannot line up by luck.
				st := &status{Tailnet: strings.Repeat("x", (i*perSender+j)%97)}
				if err := h.send(&reply{Status: st}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()

	frames := decodeFrames(t, out.buf.Bytes())
	if got, want := len(frames), senders*perSender; got != want {
		t.Fatalf("decoded %d frames, want %d", got, want)
	}
	for _, f := range frames {
		if f.Status == nil {
			t.Fatalf("frame lost its body: %+v", f)
		}
	}
}

// A command that fails must be reported, not obeyed as a reason to stop. The
// loop used to return on the first handler error, and returning from it ends
// the process — the proxy the browser is pointed at — over an "up" that
// arrived early or a LocalAPI call that missed its deadline.
func TestReadMessagesSurvivesCommandErrors(t *testing.T) {
	var in bytes.Buffer
	in.Write(frame(t, request{Cmd: CmdUp}))   // fails: tsnet is not started
	in.Write(frame(t, request{Cmd: CmdPing})) // must still be answered
	in.Write(frame(t, request{Cmd: CmdSetExitNode, ExitNode: "nyc"}))
	in.Write(frame(t, request{Cmd: CmdPing}))

	var out lockedBuffer
	h := quietHost(&in, &out)

	err := h.readMessages()
	if !errors.Is(err, io.EOF) {
		t.Fatalf("readMessages returned %v, want io.EOF once the input is exhausted", err)
	}

	var pongs, cmdErrors int
	for _, f := range decodeFrames(t, out.buf.Bytes()) {
		if f.Pong {
			pongs++
		}
		if f.CmdError != nil {
			cmdErrors++
			if !strings.Contains(f.CmdError.Error, errNotInit.Error()) {
				t.Errorf("cmdError for %q says %q, want it to mention %q", f.CmdError.Cmd, f.CmdError.Error, errNotInit)
			}
		}
	}
	if pongs != 2 {
		t.Errorf("got %d pongs, want 2: the loop stopped answering after a failed command", pongs)
	}
	if cmdErrors != 2 {
		t.Errorf("got %d cmdError replies, want 2: failed commands must be reported", cmdErrors)
	}
}

// Before init has started tsnet, asking for a LocalAPI client must fail
// rather than start one. tsnet.Server.LocalClient starts the server if it is
// not running, and at that point the hostname and state directory are unset,
// so it would bring up a stranger of a node — and init, arriving a moment
// later, would find the server "already running".
func TestLocalClientRefusesBeforeInit(t *testing.T) {
	h := quietHost(strings.NewReader(""), io.Discard)

	if _, err := h.localClient(); !errors.Is(err, errNotInit) {
		t.Fatalf("localClient before init returned %v, want %v", err, errNotInit)
	}
	if h.ts.Sys() != nil {
		t.Fatal("asking for a client before init started tsnet")
	}
}

// A browser connection that arrives before the backend is ready waits for
// it rather than failing on the spot. The extension points the browser at the
// proxy as soon as the port is known, before init is even received, so
// failing immediately meant every page loaded in the first seconds after a
// start came back as a proxy error.
func TestUserDialWaitsForTheBackend(t *testing.T) {
	h := quietHost(strings.NewReader(""), io.Discard)

	const patience = 300 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), patience)
	defer cancel()

	start := time.Now()
	_, err := h.userDial(ctx, "tcp", "example.com:443")
	elapsed := time.Since(start)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("userDial returned %v, want the caller's deadline", err)
	}
	if elapsed < patience/2 {
		t.Fatalf("userDial gave up after %v; it should have waited for the backend", elapsed)
	}
}

// The wait must also end when the caller goes away, or a page the user
// closed keeps a goroutine polling until the timeout.
func TestUserDialStopsWaitingWhenCancelled(t *testing.T) {
	h := quietHost(strings.NewReader(""), io.Discard)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := h.userDial(ctx, "tcp", "example.com:443")
		done <- err
	}()
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("userDial kept waiting after its context was cancelled")
	}
}

func TestValidInitID(t *testing.T) {
	for _, tt := range []struct {
		id   string
		want bool
	}{
		{"", false},
		{"0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", true},
		{"deadbeef", true},
		{"DEADBEEF", false},              // uppercase is not what crypto.randomUUID produces
		{"../../etc", false},             // it names a directory
		{"0f1e2d3c 4b5a", false},         // spaces
		{strings.Repeat("a", 61), false}, // too long
	} {
		if got := validInitID(tt.id) == nil; got != tt.want {
			t.Errorf("validInitID(%q) accepted=%v, want %v", tt.id, got, tt.want)
		}
	}
}

// scheduleStatus folds requests together: however many arrive while one is
// pending, the loop builds one status after them. Building one per
// notification, on the watcher's goroutine, is what let the watcher fall
// behind and get closed by the backend.
func TestScheduleStatusCoalesces(t *testing.T) {
	h := quietHost(strings.NewReader(""), io.Discard)
	for range 100 {
		h.scheduleStatus() // must never block
	}
	if got := len(h.statusCh); got != 1 {
		t.Fatalf("%d status requests queued, want 1", got)
	}
}

func TestCmdErrorReplyNamesTheCommand(t *testing.T) {
	var out lockedBuffer
	h := quietHost(strings.NewReader(""), &out)
	if err := h.send(&reply{CmdError: &cmdErrorResult{Cmd: CmdDown, Error: "boom"}}); err != nil {
		t.Fatal(err)
	}
	frames := decodeFrames(t, out.buf.Bytes())
	if len(frames) != 1 || frames[0].CmdError == nil {
		t.Fatalf("got %+v", frames)
	}
	if got := fmt.Sprint(frames[0].CmdError.Cmd); got != "down" {
		t.Errorf("cmd = %q, want %q", got, "down")
	}
}

// tsnet starts the backend with a fresh set of preferences every time, and
// Tailscale takes that as the whole set: the exit node was wiped on every
// restart of this process, which is every browser start and every reload of
// the extension. The choice is kept beside the state and put back on start.
func TestSavedExitNodeRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), savedExitNodeFile)

	// Nothing recorded yet: nothing to restore, and no error.
	s, err := readSavedExitNode(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.isSet() {
		t.Fatalf("read %+v from a missing file, want nothing set", s)
	}

	// A node resolved to its stable id.
	const id = tailcfg.StableNodeID("nodeABC")
	if err := writeSavedExitNode(path, &ipn.Prefs{ExitNodeID: id}); err != nil {
		t.Fatal(err)
	}
	s, err = readSavedExitNode(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != id || s.IP.IsValid() {
		t.Fatalf("got %+v, want id %q and no ip", s, id)
	}
	mp := s.maskedPrefs()
	if !mp.ExitNodeIDSet || !mp.ExitNodeIPSet || mp.Prefs.ExitNodeID != id {
		t.Fatalf("maskedPrefs = %+v, want both fields masked and the id set", mp)
	}

	// A node still known only by IP, as it is before the netmap arrives.
	ip := netip.MustParseAddr("100.96.115.109")
	if err := writeSavedExitNode(path, &ipn.Prefs{ExitNodeIP: ip}); err != nil {
		t.Fatal(err)
	}
	s, err = readSavedExitNode(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "" || s.IP != ip {
		t.Fatalf("got %+v, want ip %v and no id", s, ip)
	}

	// Clearing the exit node must survive a restart too, or a choice of None
	// would come back as the node before it.
	if err := writeSavedExitNode(path, &ipn.Prefs{}); err != nil {
		t.Fatal(err)
	}
	s, err = readSavedExitNode(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.isSet() {
		t.Fatalf("got %+v after clearing, want nothing set", s)
	}
}

func TestSavedExitNodeRejectsGarbage(t *testing.T) {
	path := filepath.Join(t.TempDir(), savedExitNodeFile)
	if err := os.WriteFile(path, []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSavedExitNode(path); err == nil {
		t.Fatal("a corrupt file was read as a valid choice")
	}
}

// tsnet starts the backend with WantRunning set, so a profile switched off
// came back on at every restart and the extension routed the browser through
// it. The switch is remembered like the exit node.
func TestSavedWantRunningRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), savedWantRunningFile)

	want, saved, err := readSavedWantRunning(path)
	if err != nil {
		t.Fatal(err)
	}
	if !want || saved {
		t.Fatalf("missing file read as want=%v saved=%v; the default is on and unsaved", want, saved)
	}

	if err := writeSavedWantRunning(path, false); err != nil {
		t.Fatal(err)
	}
	want, saved, err = readSavedWantRunning(path)
	if err != nil {
		t.Fatal(err)
	}
	if want || !saved {
		t.Fatalf("got want=%v saved=%v after saving off", want, saved)
	}

	if err := writeSavedWantRunning(path, true); err != nil {
		t.Fatal(err)
	}
	want, _, err = readSavedWantRunning(path)
	if err != nil {
		t.Fatal(err)
	}
	if !want {
		t.Fatal("saving on was read back as off")
	}
}

// A status that repeats the last one is not sent to the extension, unless it
// answers something. The bus watcher's notifications mostly say nothing new.
func TestEmitStatusDropsRepeats(t *testing.T) {
	var out lockedBuffer
	h := quietHost(strings.NewReader(""), &out)

	h.emitStatus(false)
	h.emitStatus(false)
	h.emitStatus(false)
	if n := len(decodeFrames(t, out.buf.Bytes())); n != 1 {
		t.Fatalf("%d statuses sent for three identical updates, want 1", n)
	}

	h.sendStatus() // an answer, sent even though nothing changed
	if n := len(decodeFrames(t, out.buf.Bytes())); n != 2 {
		t.Fatalf("%d statuses after an explicit request, want 2", n)
	}

	h.mu.Lock()
	h.lastState = ipn.Stopped
	h.mu.Unlock()
	h.emitStatus(false) // a change, sent
	frames := decodeFrames(t, out.buf.Bytes())
	if n := len(frames); n != 3 {
		t.Fatalf("%d statuses after a state change, want 3", n)
	}
	if got := frames[2].Status.Error; got != "State: Stopped" {
		t.Fatalf("last status error = %q, want State: Stopped", got)
	}
}

// The dead-watch marker must not overwrite what the extension reads to
// decide where traffic goes.
func TestWatchDeadDoesNotHideState(t *testing.T) {
	var out lockedBuffer
	h := quietHost(strings.NewReader(""), &out)
	h.mu.Lock()
	h.lastState = ipn.Stopped
	h.watchDead = true
	h.mu.Unlock()
	h.sendStatus()

	h.mu.Lock()
	h.lastState = ipn.NeedsLogin
	h.mu.Unlock()
	h.sendStatus()

	h.mu.Lock()
	h.lastState = ipn.Running
	h.mu.Unlock()
	h.sendStatus()

	frames := decodeFrames(t, out.buf.Bytes())
	if got := frames[0].Status.Error; got != "State: Stopped" {
		t.Errorf("stopped profile reported %q; the extension routes on this string", got)
	}
	if !frames[1].Status.NeedsLogin || frames[1].Status.Error != "" {
		t.Errorf("needs-login was hidden: %+v", frames[1].Status)
	}
	if got := frames[2].Status.Error; got != "WatchIPNBus stopped" {
		t.Errorf("with nothing else to say, the marker should show; got %q", got)
	}
}
