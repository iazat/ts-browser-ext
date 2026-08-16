package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale"
	"tailscale.com/hostinfo"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/net/proxymux"
	"tailscale.com/net/socks5"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
	"tailscale.com/types/netmap"
)

var (
	installFlag   = flag.String("install", "", "register the browser extension; string is 'C' (Chrome) or 'F' (Firefox) followed by extension ID")
	uninstallFlag = flag.Bool("uninstall", false, "unregister the browser extension")
)

// firefoxExtensionID must match browser_specific_settings.gecko.id in
// firefox/manifest.json. Firefox checks this value before it will let the
// extension talk to us at all, and a mismatch fails silently from the user's
// side: the extension installs, and the backend simply never answers.
// TestFirefoxExtensionIDMatchesManifest keeps the two in step.
const firefoxExtensionID = "tailext@iazat.github.io"

// Native messaging host names. Each background script passes one of these to
// connectNative, and the browser looks for a registration file of the same
// name — so these strings and the ones in the extensions have to agree, or the
// backend is simply never found. TestHostNamesMatchExtensions checks that.
const (
	chromeHostName  = "io.github.iazat.tailext.chrome"
	firefoxHostName = "io.github.iazat.tailext.firefox"
)

// legacyHostNames are the registrations written before the extension was
// renamed. They are removed on install and uninstall: left behind, they are a
// file bearing someone else's name sitting in the user's browser config, and
// a stale path to a binary this project no longer maintains.
var legacyHostNames = []string{
	"com.tailscale.browserext.chrome",
	"com.tailscale.browserext.firefox",
}

// hostName returns the native messaging host name for a browser byte.
func hostName(browserByte string) string {
	if browserByte == "F" {
		return firefoxHostName
	}
	return chromeHostName
}

func main() {
	flag.Parse()
	if *installFlag != "" {
		if err := install(*installFlag); err != nil {
			log.Fatalf("installation error: %v", err)
		}
		return
	}
	if *uninstallFlag {
		if err := uninstall(); err != nil {
			log.Fatalf("uninstallation error: %v", err)
		}
		return
	}

	if flag.NArg() == 0 {
		fmt.Printf(`ts-browser-ext is the backend for TailExt, a browser extension
for Tailscale. It runs as a child process HTTP/SOCKS5 proxy under your browser.

The extension's popup prints the exact command to register it, carrying the
extension's own ID:

     $ ts-browser-ext --install=C<chrome-extension-id>
     $ ts-browser-ext --install=F
`)
		return
	}

	hostinfo.SetApp("ts-browser-ext")

	h := newHost(os.Stdin, os.Stdout)

	if w, err := dialDebugSyslog(); err == nil {
		log.Printf("syslog dialed")
		h.logf = func(f string, a ...any) {
			fmt.Fprintf(w, f, a...)
		}
		log.SetOutput(w)
	} else {
		log.Printf("syslog: %v", err)
	}

	ln := h.getProxyListener()
	port := ln.Addr().(*net.TCPAddr).Port
	h.logf("Proxy listening on localhost:%v", port)

	h.send(&reply{ProcRunning: &procRunningResult{
		Port: port,
		Pid:  os.Getpid(),
	}})
	h.logf("Starting readMessages loop")
	err := h.readMessages()
	h.logf("readMessage loop ended: %v", err)
}

func getTargetDir(browserByte string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	var dir string
	switch runtime.GOOS {
	case "linux":
		if browserByte == "C" {
			dir = filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts")
		} else if browserByte == "F" {
			dir = filepath.Join(home, ".mozilla", "native-messaging-hosts")
		}
	case "darwin":
		if browserByte == "C" {
			dir = filepath.Join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
		} else if browserByte == "F" {
			dir = filepath.Join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts")
		}
	default:
		return "", fmt.Errorf("TODO: implement support for installing on %q", runtime.GOOS)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return dir, nil
}

func uninstall() error {
	for _, browserByte := range []string{"C", "F"} {
		targetDir, err := getTargetDir(browserByte)
		if err != nil {
			return err
		}
		targetBin := filepath.Join(targetDir, "ts-browser-ext")
		if err := os.Remove(targetBin); err != nil && !os.IsNotExist(err) {
			return err
		}
		// Both the current registration and anything an older version left.
		names := append([]string{hostName(browserByte)}, legacyHostNames...)
		for _, name := range names {
			path := filepath.Join(targetDir, name+".json")
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

func install(installArg string) error {
	browserByte, extension := installArg[0:1], installArg[1:]
	switch browserByte {
	case "C":
		extensionRE := regexp.MustCompile(`^[a-z0-9]{32}$`)
		if !extensionRE.MatchString(extension) {
			return fmt.Errorf("invalid extension ID %q", extension)
		}
	case "F":
	default:
		return fmt.Errorf("unknown browser prefix byte %q", browserByte)
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	targetDir, err := getTargetDir(browserByte)
	if err != nil {
		return err
	}
	binary, err := os.ReadFile(exe)
	if err != nil {
		return err
	}
	targetBin := filepath.Join(targetDir, "ts-browser-ext")
	if err := os.WriteFile(targetBin, binary, 0755); err != nil {
		return err
	}
	log.SetFlags(0)
	log.Printf("copied binary to %v", targetBin)

	var targetJSON string
	var jsonConf []byte

	switch browserByte {
	case "C":
		targetJSON = filepath.Join(targetDir, chromeHostName+".json")
		jsonConf = fmt.Appendf(nil, `{
		"name": "%s",
		"description": "TailExt native backend",
		"path": "%s",
		"type": "stdio",
		"allowed_origins": [
			"chrome-extension://%s/"
		]
	  }`, chromeHostName, targetBin, extension)
	case "F":
		targetJSON = filepath.Join(targetDir, firefoxHostName+".json")
		jsonConf = fmt.Appendf(nil, `{
		"name": "%s",
		"description": "TailExt native backend",
		"path": "%s",
		"type": "stdio",
		"allowed_extensions": [
			"%s"
		]
	  }`, firefoxHostName, targetBin, firefoxExtensionID)
	default:
		return fmt.Errorf("unknown browser prefix byte %q", browserByte)
	}
	if err := os.WriteFile(targetJSON, jsonConf, 0644); err != nil {
		return err
	}
	log.Printf("wrote registration to %v", targetJSON)

	// Clear registrations from before the rename, so the browser cannot find
	// two hosts and so nothing is left pointing at a binary we no longer own.
	for _, name := range legacyHostNames {
		old := filepath.Join(targetDir, name+".json")
		if err := os.Remove(old); err == nil {
			log.Printf("removed stale registration %v", old)
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

type host struct {
	br   *bufio.Reader
	w    io.Writer
	logf logger.Logf

	wmu sync.Mutex // guards writing to w

	lenBuf [4]byte // owned by readMessages

	mu              sync.Mutex
	watchDead       bool
	lastNetmap      *netmap.NetworkMap
	lastState       ipn.State
	lastBrowseToURL string
	// exitNodeSet reports whether the preferences name an exit node. It
	// starts true and is corrected by the first Prefs notification: until we
	// know otherwise we must assume traffic is meant to leave through an exit
	// node, because guessing the other way leaks the real address.
	exitNodeSet bool
	ctx         context.Context // for IPN bus; canceled by cancelCtx
	cancelCtx   context.CancelFunc
	ts          *tsnet.Server
	ln          net.Listener
	wantUp      bool
	// ...
}

func newHost(r io.Reader, w io.Writer) *host {
	h := &host{
		br:          bufio.NewReaderSize(r, 1<<20),
		w:           w,
		logf:        log.Printf,
		exitNodeSet: true, // assume the strict case until Prefs says otherwise
	}
	h.ts = &tsnet.Server{
		RunWebClient: true,

		// late-binding, so caller can adjust h.logf.
		Logf: func(f string, a ...any) {
			h.logf(f, a...)
		},
	}
	return h
}

const maxMsgSize = 1 << 20

func (h *host) readMessages() error {
	for {
		msg, err := h.readMessage()
		if err != nil {
			return err
		}
		if err := h.handleMessage(msg); err != nil {
			h.logf("error handling message %v: %v", msg, err)
			return err
		}
	}
}

func (h *host) handleMessage(msg *request) error {
	switch msg.Cmd {
	case CmdInit:
		return h.handleInit(msg)
	case CmdGetStatus:
		h.sendStatus()
	case CmdUp:
		return h.handleUp()
	case CmdDown:
		return h.handleDown()
	case CmdSetExitNode:
		return h.handleSetExitNode(msg)
	default:
		h.logf("unknown command %q", msg.Cmd)
	}
	return nil
}

func (h *host) handleUp() error {
	return h.setWantRunning(true)
}

func (h *host) handleDown() error {
	return h.setWantRunning(false)
}

func (h *host) setWantRunning(want bool) error {
	defer h.sendStatus()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ts.Sys() == nil {
		return fmt.Errorf("not init")
	}
	h.wantUp = want
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	lc, err := h.ts.LocalClient()
	if err != nil {
		return err
	}
	if _, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{
		WantRunningSet: true,
		Prefs: ipn.Prefs{
			WantRunning: want,
		},
	}); err != nil {
		return fmt.Errorf("EditPrefs to wantRunning=%v: %w", want, err)
	}
	return nil
}

// handleSetExitNode sets (or, with an empty name, clears) the exit node for
// this profile. The name is an IP or a peer hostname/FQDN, resolved against
// the current status the same way `tailscale set --exit-node` does.
func (h *host) handleSetExitNode(msg *request) error {
	defer h.sendStatus()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ts.Sys() == nil {
		return fmt.Errorf("not init")
	}
	lc, err := h.ts.LocalClient()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return applyExitNode(ctx, lc, msg.ExitNode)
}

// applyExitNode sets (or, with an empty name, clears) the exit node. The name
// is an IP or peer hostname/FQDN, resolved against the current status the same
// way `tailscale set --exit-node` does.
func applyExitNode(ctx context.Context, lc *local.Client, name string) error {
	// Setting ExitNodeIDSet with an empty ID clears any stale ID so that the
	// resolved ExitNodeIP takes effect; both zero clears the exit node entirely.
	mp := &ipn.MaskedPrefs{
		ExitNodeIDSet: true,
		ExitNodeIPSet: true,
	}
	if name != "" {
		st, err := lc.Status(ctx)
		if err != nil {
			return err
		}
		var p ipn.Prefs
		if err := p.SetExitNodeIP(name, st); err != nil {
			return fmt.Errorf("resolving exit node %q: %w", name, err)
		}
		mp.Prefs.ExitNodeIP = p.ExitNodeIP
	}
	if _, err := lc.EditPrefs(ctx, mp); err != nil {
		return fmt.Errorf("EditPrefs exit node: %w", err)
	}
	return nil
}

// isConfiguredExitNode reports whether a peer is the exit node this profile is
// set to use.
//
// ipnstate's ExitNode flag means "currently carrying this node's traffic",
// which is a different question: it is false while the extension is switched
// off, and for the first moments after it is switched on, before the route
// comes up. Reading it alone makes the picker say None for a selection that is
// still very much configured. The preferences are the answer — they survive
// going down and coming back up.
//
// Which of ExitNodeID and ExitNodeIP is populated depends on how the node was
// selected and on what the backend has since resolved, so both are checked.
func isConfiguredExitNode(ps *ipnstate.PeerStatus, prefID tailcfg.StableNodeID, prefIP netip.Addr) bool {
	if ps.ExitNode {
		return true
	}
	if prefID != "" && ps.ID == prefID {
		return true
	}
	if prefIP.IsValid() {
		for _, ip := range ps.TailscaleIPs {
			if ip == prefIP {
				return true
			}
		}
	}
	return false
}

// configuredExitNode returns the exit node preferences, or zero values if they
// cannot be read. A failure here only costs the picker its selection, so it is
// not worth failing a status update over — but it is worth saying out loud,
// because a failure and "no exit node is set" are the same two return values
// and the picker reads both as None.
//
// It takes its own deadline rather than inheriting the caller's. Sharing a
// context with the Status call ahead of it meant that a slow Status — which is
// exactly what happens just after a restart, while the peer list is being
// built from a fresh netmap — left too little of it for this, and the
// selection silently vanished from the picker at the one moment the user is
// most likely to look.
func configuredExitNode(lc *local.Client, logf logger.Logf) (tailcfg.StableNodeID, netip.Addr) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		logf("reading exit node preferences: %v; the picker will show None", err)
		return "", netip.Addr{}
	}
	return prefs.ExitNodeID, prefs.ExitNodeIP
}

// machineName returns the admin-panel machine name (first DNS label) for a
// peer, falling back to its hostname.
func machineName(dnsName, hostName string) string {
	name := strings.TrimSuffix(dnsName, ".")
	if name == "" {
		return hostName
	}
	if i := strings.IndexByte(name, '.'); i >= 0 {
		return name[:i]
	}
	return name
}

func (h *host) handleInit(msg *request) (ret error) {
	defer func() {
		var errMsg string
		if ret != nil {
			errMsg = ret.Error()
		}
		h.send(&reply{
			Init: &initResult{Error: errMsg},
		})
	}()
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.cancelCtx != nil {
		h.cancelCtx()
	}
	h.ctx, h.cancelCtx = context.WithCancel(context.Background())

	id := msg.InitID
	if len(id) == 0 {
		return fmt.Errorf("missing initID")
	}
	if len(id) > 60 {
		return fmt.Errorf("initID too long")
	}
	for i := range len(id) {
		b := id[i]
		if b == '-' || (b >= 'a' && b <= 'f') || (b >= '0' && b <= '9') {
			continue
		}
		return errors.New("invalid initID character")
	}

	if h.ts.Sys() != nil {
		return fmt.Errorf("already running")
	}
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("getting current user: %w", err)
	}
	h.ts.Hostname = u.Username + "-browser-ext"

	confDir, err := os.UserConfigDir()
	if err != nil {
		return fmt.Errorf("getting user config dir: %w", err)
	}
	h.ts.Dir = filepath.Join(confDir, "tailscale-browser-ext", id)

	h.logf("Starting...")
	if err := h.ts.Start(); err != nil {
		return fmt.Errorf("starting tsnet.Server: %w", err)
	}
	h.logf("Started")

	lc, err := h.ts.LocalClient()
	if err != nil {
		return fmt.Errorf("getting local client: %w", err)
	}

	// NotifyInitialNetMap matters: without it the first netmap only arrives
	// when something about the tailnet happens to change, so a backend that
	// comes up already logged in reports an empty tailnet name until then.
	// It is not one of NotifyRateLimitIncompatibleBits, so it combines.
	wc, err := lc.WatchIPNBus(h.ctx, ipn.NotifyInitialState|ipn.NotifyInitialNetMap|ipn.NotifyInitialPrefs|ipn.NotifyRateLimit)
	if err != nil {
		return fmt.Errorf("watching IPN bus: %w", err)
	}
	go h.watchIPNBus(wc)

	return nil
}

func (h *host) watchIPNBus(wc *tailscale.IPNBusWatcher) {
	h.mu.Lock()
	h.watchDead = false
	h.mu.Unlock()

	for h.updateFromWatcher(wc) {
		// Keep going.
	}
}

func (h *host) updateFromWatcher(wc *tailscale.IPNBusWatcher) bool {
	n, err := wc.Next()

	defer h.sendStatus()

	h.mu.Lock()
	defer h.mu.Unlock()

	if err != nil {
		log.Printf("watchIPNBus: %v", err)
		h.watchDead = true
		return false
	}

	if n.NetMap != nil {
		h.lastNetmap = n.NetMap
	}
	if n.State != nil {
		h.lastState = *n.State
	}

	if n.Prefs != nil {
		p := *n.Prefs
		h.exitNodeSet = p.ExitNodeID() != "" || p.ExitNodeIP().IsValid()
	}

	if n.BrowseToURL != nil {
		h.lastBrowseToURL = *n.BrowseToURL
		// TODO: pop a browser for Tailscale SSH check mode etc, even
		// if already logged in.
	}
	return true
}

func (h *host) send(msg *reply) error {
	msgb, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("json encoding of message: %w", err)
	}
	h.logf("sent reply: %s", msgb)
	if len(msgb) > maxMsgSize {
		return fmt.Errorf("message too big (%v)", len(msgb))
	}
	binary.LittleEndian.PutUint32(h.lenBuf[:], uint32(len(msgb)))
	h.wmu.Lock()
	defer h.wmu.Unlock()
	if _, err := h.w.Write(h.lenBuf[:]); err != nil {
		return err
	}
	if _, err := h.w.Write(msgb); err != nil {
		return err
	}
	return nil
}

func (h *host) getProxyListener() net.Listener {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.getProxyListenerLocked()
}

func (h *host) getProxyListenerLocked() net.Listener {
	if h.ln != nil {
		return h.ln
	}
	var err error
	h.ln, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err) // TODO: be more graceful
	}
	socksListener, httpListener := proxymux.SplitSOCKSAndHTTP(h.ln)

	hs := &http.Server{Handler: h.httpProxyHandler()}
	go func() {
		log.Fatalf("HTTP proxy exited: %v", hs.Serve(httpListener))
	}()
	ss := &socks5.Server{
		Logf:   logger.WithPrefix(h.logf, "socks5: "),
		Dialer: h.userDial,
	}
	go func() {
		log.Fatalf("SOCKS5 server exited: %v", ss.Serve(socksListener))
	}()
	return h.ln
}

// safeToDial reports whether browser traffic may be sent out through tsnet
// given the backend's current state.
//
// The proxy listener comes up and its port is announced to the extension
// before tsnet has finished starting, so there is a window — seconds, on a
// cold start — in which a dial succeeds but leaves through this machine's own
// connection instead of the exit node. Nothing about that is visible
// afterwards: by the time anyone looks, the backend is Running and reports
// the exit node correctly. A page loaded in that window has already gone out
// from the real address.
//
// Two states are allowed through deliberately:
//
// Without an exit node configured, leaving through this machine is what the
// user asked for, not a leak.
//
// NeedsLogin is exempt because the browser is proxied through here: refusing
// to dial while someone still has to reach the login page would lock them out
// of the thing that fixes it. That state is at least loud — the popup says so
// and the icon shows offline — unlike the silent startup window.
func safeToDial(state ipn.State, exitNodeSet bool) bool {
	if !exitNodeSet {
		return true
	}
	return state == ipn.Running || state == ipn.NeedsLogin
}

func (h *host) userDial(ctx context.Context, netw, addr string) (net.Conn, error) {
	h.mu.Lock()
	sys := h.ts.Sys()
	state := h.lastState
	exitNodeSet := h.exitNodeSet
	h.mu.Unlock()

	if sys == nil {
		h.logf("userDial to %v/%v without a tsnet.Server started", netw, addr)
		return nil, fmt.Errorf("no tsnet.Server")
	}

	if !safeToDial(state, exitNodeSet) {
		h.logf("userDial to %v/%v refused: exit node configured, backend in state %v", netw, addr, state)
		return nil, fmt.Errorf("not routing yet: an exit node is configured but the tailnet is %v", state)
	}

	return sys.Dialer.Get().UserDial(ctx, netw, addr)
}

func (h *host) sendStatus() {
	st := &status{}
	h.mu.Lock()
	st.Running = h.lastState == ipn.Running
	if nm := h.lastNetmap; nm != nil {
		st.Tailnet = nm.Domain
	}
	if h.lastState == ipn.NeedsLogin {
		st.NeedsLogin = true
		st.BrowseToURL = h.lastBrowseToURL
	} else if !st.Running {
		st.Error = "State: " + h.lastState.String()
	}
	if h.watchDead {
		st.Error = "WatchIPNBus stopped"
	}
	hasServer := h.ts.Sys() != nil
	h.mu.Unlock()

	// Populate the exit node list outside the lock (it does IPC).
	if hasServer {
		if lc, err := h.ts.LocalClient(); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if full, err := lc.Status(ctx); err == nil {
				// The management page reads the tailnet from here and got it
				// right while the popup showed nothing, so trust this when
				// the netmap has not given us a name.
				if st.Tailnet == "" && full.CurrentTailnet != nil {
					st.Tailnet = full.CurrentTailnet.Name
				}
				prefID, prefIP := configuredExitNode(lc, h.logf)
				for _, ps := range full.Peer {
					if !ps.ExitNodeOption {
						continue
					}
					name := strings.TrimSuffix(ps.DNSName, ".")
					if name == "" {
						name = ps.HostName
					}
					selected := isConfiguredExitNode(ps, prefID, prefIP)
					st.ExitNodes = append(st.ExitNodes, exitNodeInfo{
						Name:     name,
						Online:   ps.Online,
						Selected: selected,
					})
					if selected {
						st.ExitNode = name
					}
				}
				sort.Slice(st.ExitNodes, func(i, j int) bool {
					return st.ExitNodes[i].Name < st.ExitNodes[j].Name
				})
			}
			cancel()
		}
	}

	if err := h.send(&reply{Status: st}); err != nil {
		h.logf("failed to send status: %v", err)
	}
}

type Cmd string

const (
	CmdInit        Cmd = "init"
	CmdUp          Cmd = "up"
	CmdDown        Cmd = "down"
	CmdGetStatus   Cmd = "get-status"
	CmdSetExitNode Cmd = "set-exit-node"
)

// request is a message from the browser extension.
type request struct {
	// Cmd is the request type.
	Cmd Cmd `json:"cmd"`

	// InitID is the unique ID made by the extension (in its local storage) to
	// distinguish between different browser profiles using the same extension.
	// A given Go process will correspond to a single browser profile.
	// This lets us store tsnet state in different directories.
	// This string, coming from JavaScript, should not be trusted. It must be
	// UUID-ish: hex and hyphens only, and too long.
	InitID string `json:"initID,omitempty"`

	// ExitNode is the exit node to use for [CmdSetExitNode]: an IP or peer
	// hostname/FQDN, or empty to stop using an exit node.
	ExitNode string `json:"exitNode,omitempty"`

	// ...
}

// reply is a message to the browser extension.
type reply struct {
	// ProcRunning is set on the first message when the Go process starts up.
	// It's the message that makes the browser recognize that the native
	// messaging port is up.
	ProcRunning *procRunningResult `json:"procRunning,omitempty"`

	// Status is sent in response to a [CmdGetStatus] [request.Cmd].
	Status *status `json:"status,omitempty"`

	Init *initResult `json:"init,omitempty"`
}

type procRunningResult struct {
	Port  int    `json:"port"` // HTTP+SOCKS5 localhost proxy port
	Pid   int    `json:"pid"`
	Error string `json:"error"`
}

type initResult struct {
	Error string `json:"error"` // empty for none
}

type status struct {
	Running bool   `json:"running"`
	Tailnet string `json:"tailnet"`
	Error   string `json:"error,omitempty"`

	NeedsLogin  bool   `json:"needsLogin,omitempty"` // true if the user needs to log in
	BrowseToURL string `json:"browseToURL"`

	ExitNode  string         `json:"exitNode,omitempty"`  // name of the currently selected exit node, if any
	ExitNodes []exitNodeInfo `json:"exitNodes,omitempty"` // exit nodes available to pick from
}

type exitNodeInfo struct {
	Name     string `json:"name"` // FQDN (without trailing dot) used to select the node
	Online   bool   `json:"online"`
	Selected bool   `json:"selected"`
}

func (h *host) readMessage() (*request, error) {
	if _, err := io.ReadFull(h.br, h.lenBuf[:]); err != nil {
		return nil, err
	}
	msgSize := binary.LittleEndian.Uint32(h.lenBuf[:])
	if msgSize > maxMsgSize {
		return nil, fmt.Errorf("message size too big (%v)", msgSize)
	}
	msgb := make([]byte, msgSize)
	if n, err := io.ReadFull(h.br, msgb); err != nil {
		return nil, fmt.Errorf("read %v of %v bytes in message with error %v", n, msgSize, err)
	}
	msg := new(request)
	if err := json.Unmarshal(msgb, msg); err != nil {
		return nil, fmt.Errorf("invalid JSON decoding of message: %w", err)
	}
	h.logf("got command %q: %s", msg.Cmd, msgb)
	return msg, nil
}

// serveInternal serves the extension's own management page at
// http://100.100.100.100/. Requests arrive over the local proxy (we control
// both ends), so no per-request tailnet auth is needed here.
func (h *host) serveInternal(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/" && r.Method == "GET":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, internalPageHTML)
	case r.URL.Path == "/api/data" && r.Method == "GET":
		h.serveInternalData(w, r)
	case r.URL.Path == "/api/exit-node" && r.Method == "POST":
		h.serveInternalSetExitNode(w, r)
	case r.URL.Path == "/api/logout" && r.Method == "POST":
		h.serveInternalLogout(w, r)
	default:
		http.NotFound(w, r)
	}
}

type webData struct {
	Running  bool      `json:"running"`
	State    string    `json:"state"` // raw IPN backend state (Running, Starting, NeedsMachineAuth, ...)
	Tailnet  string    `json:"tailnet"`
	SelfName string    `json:"selfName"`
	SelfIP   string    `json:"selfIP"`
	Version  string    `json:"version"`
	ExitNode string    `json:"exitNode"`
	Peers    []webPeer `json:"peers"`
}

type webPeer struct {
	Name           string `json:"name"`
	IP             string `json:"ip"`
	OS             string `json:"os"`
	Online         bool   `json:"online"`
	ExitNodeOption bool   `json:"exitNodeOption"`
}

func firstIP(ips []netip.Addr) string {
	if len(ips) == 0 {
		return ""
	}
	return ips[0].String()
}

func (h *host) serveInternalData(w http.ResponseWriter, r *http.Request) {
	lc, err := h.ts.LocalClient()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	st, err := lc.Status(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	d := webData{
		Running: st.BackendState == "Running",
		State:   st.BackendState,
		Version: st.Version,
	}
	if st.CurrentTailnet != nil {
		d.Tailnet = st.CurrentTailnet.Name
	}
	if st.Self != nil {
		d.SelfName = machineName(st.Self.DNSName, st.Self.HostName)
		d.SelfIP = firstIP(st.Self.TailscaleIPs)
	}
	prefID, prefIP := configuredExitNode(lc, h.logf)
	for _, ps := range st.Peer {
		if isConfiguredExitNode(ps, prefID, prefIP) {
			d.ExitNode = machineName(ps.DNSName, ps.HostName)
		}
		d.Peers = append(d.Peers, webPeer{
			Name:           machineName(ps.DNSName, ps.HostName),
			IP:             firstIP(ps.TailscaleIPs),
			OS:             ps.OS,
			Online:         ps.Online,
			ExitNodeOption: ps.ExitNodeOption,
		})
	}
	sort.Slice(d.Peers, func(i, j int) bool { return d.Peers[i].Name < d.Peers[j].Name })
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(d)
}

func (h *host) serveInternalSetExitNode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ExitNode string `json:"exitNode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	lc, err := h.ts.LocalClient()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := applyExitNode(r.Context(), lc, body.ExitNode); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	h.sendStatus() // keep the popup's dropdown in sync
	w.WriteHeader(204)
}

func (h *host) serveInternalLogout(w http.ResponseWriter, r *http.Request) {
	lc, err := h.ts.LocalClient()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := lc.Logout(r.Context()); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	h.sendStatus()
	w.WriteHeader(204)
}

// httpProxyHandler returns an HTTP proxy http.Handler using the
// provided backend dialer.
func (h *host) httpProxyHandler() http.Handler {
	rp := &httputil.ReverseProxy{
		Director: func(r *http.Request) {}, // no change
		Transport: &http.Transport{
			DialContext: h.userDial,
		},
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == "100.100.100.100" {
			h.serveInternal(w, r)
			return
		}

		if r.Method != "CONNECT" {
			backURL := r.RequestURI
			if strings.HasPrefix(backURL, "/") || backURL == "*" {
				http.Error(w, "bogus RequestURI; must be absolute URL or CONNECT", 400)
				return
			}
			rp.ServeHTTP(w, r)
			return
		}

		// CONNECT support:

		dst := r.RequestURI
		c, err := h.userDial(r.Context(), "tcp", dst)
		if err != nil {
			w.Header().Set("Tailscale-Connect-Error", err.Error())
			http.Error(w, err.Error(), 500)
			return
		}
		defer c.Close()

		cc, ccbuf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer cc.Close()

		io.WriteString(cc, "HTTP/1.1 200 OK\r\n\r\n")

		var clientSrc io.Reader = ccbuf
		if ccbuf.Reader.Buffered() == 0 {
			// In the common case (with no
			// buffered data), read directly from
			// the underlying client connection to
			// save some memory, letting the
			// bufio.Reader/Writer get GC'ed.
			clientSrc = cc
		}

		errc := make(chan error, 1)
		go func() {
			_, err := io.Copy(cc, c)
			errc <- err
		}()
		go func() {
			_, err := io.Copy(c, clientSrc)
			errc <- err
		}()
		<-errc
	})
}

// internalPageHTML is the management page served at http://100.100.100.100/.
// It fetches /api/data and posts to /api/exit-node and /api/logout.
const internalPageHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TailExt</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f7f5f4;
    --fg: #1f1e1e;
    --muted: #706e6c;
    --line: #e6e3e1;
    --card: #ffffff;
    --blue: #4b70cc;
    --green: #1aa179;
  }
  * { box-sizing: border-box; }
  body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; background: var(--bg); color: var(--fg); -webkit-font-smoothing: antialiased;
    font-size: 14px; line-height: 1.5; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 28px 20px 56px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand svg { width: 26px; height: 26px; display: block; }
  .brand h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    font-weight: 600; color: var(--muted); margin: 28px 0 10px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 4px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  .card.pad { padding: 16px; }
  .row { display: flex; justify-content: space-between; gap: 12px; align-items: center;
    padding: 11px 0; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: none; }
  .row .k { color: var(--muted); }
  .row .v { font-weight: 500; text-align: right; word-break: break-all; }
  select, button { font-size: 14px; border-radius: 8px; font-family: inherit; }
  select { padding: 9px 34px 9px 12px; border: 1px solid var(--line); background: #fbfafa;
    appearance: none; -webkit-appearance: none; cursor: pointer; font-weight: 500; min-width: 200px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%231F1E1E' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 12px center; }
  select:hover { border-color: #d2cfcc; }
  button { padding: 8px 16px; background: var(--fg); color: #fff; border: 1px solid var(--fg);
    cursor: pointer; font-weight: 500; transition: background 0.15s; }
  button:hover { background: #000; }
  button.danger { background: #fff; color: #c0392b; border-color: var(--line); }
  button.danger:hover { background: #fdf2f1; border-color: #e9b8b2; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 11px 8px; border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.04em; }
  td.name { font-weight: 500; }
  td.muted { color: var(--muted); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px;
    vertical-align: middle; }
  .dot.on { background: var(--green); } .dot.off { background: #cdc9c6; }
  .dot.wait { background: #e0a02e; animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  .pill { display: inline-block; font-size: 11px; font-weight: 500; color: var(--blue);
    background: #eef2fb; border-radius: 5px; padding: 1px 6px; margin-left: 8px;
    vertical-align: middle; }
  #err { color: #c0392b; font-size: 13px; margin-top: 10px; }
  .credit { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--line);
    font-size: 12px; color: var(--muted); text-align: center; }
  .credit a { color: var(--blue); text-decoration: none; }
  .credit a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="16" y="16" width="480" height="480" rx="96" fill="#021204"/>
        <rect x="59" y="59" width="106" height="106" rx="53" fill="#224A33"/>
        <rect x="203" y="59" width="106" height="106" rx="53" fill="#224A33"/>
        <rect x="347" y="59" width="106" height="106" rx="53" fill="#224A33"/>
        <rect x="59" y="347" width="106" height="106" rx="53" fill="#224A33"/>
        <rect x="347" y="347" width="106" height="106" rx="53" fill="#224A33"/>
        <g fill="#2AFF43">
          <path d="M305.222 333.913C306.616 335.298 307.313 335.991 307.812 336.8C308.254 337.518 308.58 338.301 308.777 339.12C309 340.044 309 341.027 309 342.992L309 440.2C309 444.68 309 446.921 308.128 448.632C307.361 450.137 306.137 451.361 304.632 452.128C302.921 453 300.68 453 296.2 453L215.8 453C211.32 453 209.079 453 207.368 452.128C205.863 451.361 204.639 450.137 203.872 448.632C203 446.921 203 444.68 203 440.2L203 342.992C203 341.027 203 340.044 203.223 339.12C203.42 338.301 203.746 337.518 204.188 336.8C204.687 335.991 205.384 335.298 206.778 333.913L246.978 293.966C250.138 290.825 251.718 289.255 253.537 288.667C255.138 288.149 256.862 288.149 258.463 288.667C260.282 289.255 261.862 290.825 265.022 293.966L305.222 333.913Z"/>
          <path d="M333.913 206.778C335.298 205.384 335.991 204.687 336.8 204.188C337.518 203.746 338.301 203.42 339.12 203.223C340.044 203 341.027 203 342.992 203L440.2 203C444.68 203 446.921 203 448.632 203.872C450.137 204.639 451.361 205.863 452.128 207.368C453 209.079 453 211.32 453 215.8V296.2C453 300.68 453 302.921 452.128 304.632C451.361 306.137 450.137 307.361 448.632 308.128C446.921 309 444.68 309 440.2 309H342.992C341.027 309 340.044 309 339.12 308.777C338.301 308.58 337.518 308.254 336.8 307.812C335.991 307.313 335.298 306.616 333.913 305.222L293.966 265.022C290.825 261.862 289.255 260.282 288.667 258.463C288.149 256.862 288.149 255.138 288.667 253.537C289.255 251.718 290.825 250.138 293.966 246.978L333.913 206.778Z"/>
          <path d="M178.087 206.778C176.702 205.384 176.009 204.687 175.2 204.188C174.482 203.746 173.699 203.42 172.88 203.223C171.956 203 170.973 203 169.008 203L71.8 203C67.3196 203 65.0794 203 63.3681 203.872C61.8628 204.639 60.6389 205.863 59.8719 207.368C59 209.079 59 211.32 59 215.8L59 296.2C59 300.68 59 302.921 59.8719 304.632C60.6389 306.137 61.8628 307.361 63.3681 308.128C65.0794 309 67.3196 309 71.8 309H169.008C170.973 309 171.956 309 172.88 308.777C173.699 308.58 174.482 308.254 175.2 307.812C176.009 307.313 176.702 306.616 178.087 305.222L218.034 265.022C221.175 261.862 222.745 260.282 223.333 258.463C223.851 256.862 223.851 255.138 223.333 253.537C222.745 251.718 221.175 250.138 218.034 246.978L178.087 206.778Z"/>
        </g>
      </svg>
      <h1>TailExt</h1>
    </div>
    <button id="logout" class="danger">Log out</button>
  </header>

  <h2>This device</h2>
  <div class="card" id="self"></div>

  <h2>Exit node</h2>
  <div class="card pad">
    <select id="exitNode"></select>
    <div id="err"></div>
  </div>

  <h2>Machines</h2>
  <div class="card"><table id="peers"><tbody></tbody></table></div>

  <footer class="credit">
    Based on <a href="https://github.com/tailscale/ts-browser-ext" target="_blank" rel="noreferrer">Tailscale</a>'s code,
    reworked with 🖤 by <a href="https://github.com/iazat" target="_blank" rel="noreferrer">iazat</a>.
  </footer>
</div>

<script>
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function(c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

async function load() {
  const r = await fetch("/api/data");
  if (!r.ok) { document.getElementById("err").textContent = await r.text(); return; }
  const d = await r.json();

  document.getElementById("self").innerHTML =
    row("Status", statusLabel(d.state)) +
    row("Machine", esc(d.selfName)) +
    row("Tailnet", esc(d.tailnet)) +
    row("Tailscale IP", esc(d.selfIP)) +
    row("Backend", esc(d.version));

  const sel = document.getElementById("exitNode");
  let opts = '<option value=""' + (d.exitNode ? "" : " selected") + ">None</option>";
  for (const p of d.peers) {
    if (!p.exitNodeOption) continue;
    const label = esc(p.name) + (p.online ? "" : " (offline)");
    opts += '<option value="' + esc(p.name) + '"' + (p.name === d.exitNode ? " selected" : "") + ">" + label + "</option>";
  }
  sel.innerHTML = opts;

  const rows = d.peers.map(function(p) {
    return '<tr><td class="name">' + '<span class="dot ' + (p.online ? "on" : "off") + '"></span>' + esc(p.name) +
      (p.exitNodeOption ? '<span class="pill">exit</span>' : "") + "</td>" +
      "<td>" + esc(p.ip) + '</td><td class="muted">' + esc(p.os) + "</td></tr>";
  }).join("");
  document.querySelector("#peers tbody").innerHTML =
    "<tr><th>Machine</th><th>Address</th><th>OS</th></tr>" + rows;
}

function row(k, v) { return '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>"; }

function statusLabel(state) {
  if (state === "Running") return '<span class="dot on"></span>Connected';
  if (state === "Starting" || state === "NoState") return '<span class="dot wait"></span>Connecting…';
  if (state === "NeedsMachineAuth") return '<span class="dot wait"></span>Waiting for approval…';
  if (state === "NeedsLogin") return '<span class="dot off"></span>Needs login';
  return '<span class="dot off"></span>Disconnected';
}

document.getElementById("exitNode").addEventListener("change", async function(e) {
  document.getElementById("err").textContent = "";
  const r = await fetch("/api/exit-node", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exitNode: e.target.value }) });
  if (!r.ok) document.getElementById("err").textContent = await r.text();
  load();
});

document.getElementById("logout").addEventListener("click", async function() {
  if (!confirm("Log out of this tailnet?")) return;
  await fetch("/api/logout", { method: "POST" });
  load();
});

load();
setInterval(load, 5000);
</script>
</body>
</html>`
