package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/types/ptr"
)

func TestMachineName(t *testing.T) {
	cases := []struct{ dns, host, want string }{
		{"contabo-eur.taile1ef5e.ts.net.", "contabo", "contabo-eur"},
		{"do-fra-oomaipro.taile1ef5e.ts.net", "x", "do-fra-oomaipro"},
		{"", "fallbackhost", "fallbackhost"},
		{"single", "x", "single"},
	}
	for _, c := range cases {
		if got := machineName(c.dns, c.host); got != c.want {
			t.Errorf("machineName(%q,%q)=%q want %q", c.dns, c.host, got, c.want)
		}
	}
}

// fakeWatcher plays back a run of notifications and then breaks, the way a real
// watch does when the connection under it goes away. gate holds it open until a
// test is ready for that; ctx keeps a watch alive until the test is done.
type fakeWatcher struct {
	mu     sync.Mutex
	notify []ipn.Notify
	gate   <-chan struct{}
	ctx    context.Context
	err    error
	closed bool
}

func (w *fakeWatcher) Next() (ipn.Notify, error) {
	w.mu.Lock()
	if len(w.notify) > 0 {
		n := w.notify[0]
		w.notify = w.notify[1:]
		w.mu.Unlock()
		return n, nil
	}
	w.mu.Unlock()
	if w.gate != nil {
		<-w.gate
	}
	if w.ctx != nil {
		<-w.ctx.Done()
		return ipn.Notify{}, w.ctx.Err()
	}
	return ipn.Notify{}, w.err
}

func (w *fakeWatcher) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	return nil
}

func (w *fakeWatcher) isClosed() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.closed
}

// waitState waits for the backend state the host has last been told about.
func waitState(t *testing.T, h *host, want ipn.State) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		got := h.lastState
		h.mu.Unlock()
		if got == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for the backend state to reach %v", want)
}

// TestWatchBusSurvivesABrokenWatch is the sleep-and-wake case in miniature.
//
// A Mac that wakes up hands the backend a watch that is already broken. That
// used to end the goroutine reading it for good: the process stayed up with no
// idea what the tailnet was doing, the popup went on showing whatever it had
// said when the lid closed, and nothing short of restarting the browser fixed
// it. The watch has to be rebuilt, including when the first attempt to rebuild
// it fails because the backend is still on its way back.
func TestWatchBusSurvivesABrokenWatch(t *testing.T) {
	h := newHost(strings.NewReader(""), io.Discard)
	h.logf = t.Logf
	h.watchRetryMin = time.Millisecond
	h.watchRetryMax = 2 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	breakIt := make(chan struct{})
	broken := &fakeWatcher{
		notify: []ipn.Notify{{State: ptr.To(ipn.Running)}},
		gate:   breakIt,
		err:    errors.New("connection reset by peer"),
	}
	replacement := &fakeWatcher{
		notify: []ipn.Notify{{State: ptr.To(ipn.Stopped)}},
		ctx:    ctx, // stays up until the test is finished with it
	}

	var mu sync.Mutex
	tries := 0
	reconnect := func(context.Context) (busWatcher, error) {
		mu.Lock()
		tries++
		first := tries == 1
		mu.Unlock()
		if first {
			return nil, errors.New("backend not answering yet")
		}
		return replacement, nil
	}

	done := make(chan struct{})
	go func() {
		h.watchBus(ctx, broken, reconnect)
		close(done)
	}()

	waitState(t, h, ipn.Running) // the watch it started with is being read
	close(breakIt)               // ... and now it breaks, as a wake breaks it
	waitState(t, h, ipn.Stopped) // the replacement is being read

	if !broken.isClosed() {
		t.Error("the broken watch was left open; its connection is never given back")
	}
	mu.Lock()
	got := tries
	mu.Unlock()
	if got < 2 {
		t.Errorf("gave up after %d attempt(s); a backend that is still starting takes more", got)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("watchBus kept running after its context was canceled")
	}
	if !replacement.isClosed() {
		t.Error("the replacement watch was left open when the loop stopped")
	}
}

// frames reads the length-prefixed messages written to the extension.
func frames(t *testing.T, b *bytes.Buffer) []string {
	t.Helper()
	var out []string
	for b.Len() > 0 {
		var lenBuf [4]byte
		if _, err := io.ReadFull(b, lenBuf[:]); err != nil {
			t.Fatalf("reading frame length: %v", err)
		}
		msg := make([]byte, binary.LittleEndian.Uint32(lenBuf[:]))
		if _, err := io.ReadFull(b, msg); err != nil {
			t.Fatalf("reading frame body: %v", err)
		}
		out = append(out, string(msg))
	}
	return out
}

// TestSendStatusSkipsRepeats keeps a quiet tailnet quiet on the wire.
//
// The IPN bus fires for anything that happens out there, and most of it does
// not change a word of what the extension is shown. Each repeat cost two
// round-trips to this process's own backend for the peer list, and cost the
// extension a redraw of the toolbar icon — the button the user is reaching
// for. What a request asks for is still always answered.
func TestSendStatusSkipsRepeats(t *testing.T) {
	var buf bytes.Buffer
	h := newHost(strings.NewReader(""), &buf)
	h.logf = t.Logf

	h.lastState = ipn.Running
	h.sendStatus()
	h.sendStatus()
	h.sendStatus()
	if got := frames(t, &buf); len(got) != 1 {
		t.Fatalf("sent %d statuses for one unchanged state, want 1: %q", len(got), got)
	}

	h.lastState = ipn.Stopped
	h.sendStatus()
	got := frames(t, &buf)
	if len(got) != 1 {
		t.Fatalf("sent %d statuses for a state that did change, want 1: %q", len(got), got)
	}
	if !strings.Contains(got[0], "Stopped") {
		t.Errorf("status does not carry the new state: %q", got[0])
	}

	h.answerStatus()
	if got := frames(t, &buf); len(got) != 1 {
		t.Errorf("a request went unanswered because the answer had not changed: %q", got)
	}
}
