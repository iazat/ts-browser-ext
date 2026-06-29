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
	"log/syslog"
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
	"tailscale.com/net/proxymux"
	"tailscale.com/net/socks5"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
	"tailscale.com/types/netmap"
)

var (
	installFlag   = flag.String("install", "", "register the browser extension; string is 'C' (Chrome) or 'F' (Firefox) followed by extension ID")
	uninstallFlag = flag.Bool("uninstall", false, "unregister the browser extension")
)

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
		fmt.Printf(`ts-browser-ext is the backend for the Tailscale browser extension,
running as a child process HTTP/SOCKS5 under your browser.

To register it once, run:

     $ ts-browser-ext --install=chrome
`)
		return
	}

	hostinfo.SetApp("ts-browser-ext")

	h := newHost(os.Stdin, os.Stdout)

	if w, err := syslog.Dial("tcp", "localhost:5555", syslog.LOG_INFO, "browser"); err == nil {
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
		targetJSON := filepath.Join(targetDir, "com.tailscale.browserext.chrome.json")
		if browserByte == "F" {
			targetJSON = filepath.Join(targetDir, "com.tailscale.browserext.firefox.json")
		}
		if err := os.Remove(targetBin); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Remove(targetJSON); err != nil && !os.IsNotExist(err) {
			return err
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
		targetJSON = filepath.Join(targetDir, "com.tailscale.browserext.chrome.json")
		jsonConf = fmt.Appendf(nil, `{
		"name": "com.tailscale.browserext.chrome",
		"description": "Tailscale Browser Extension",
		"path": "%s",
		"type": "stdio",
		"allowed_origins": [
			"chrome-extension://%s/"
		]
	  }`, targetBin, extension)
	case "F":
		targetJSON = filepath.Join(targetDir, "com.tailscale.browserext.firefox.json")
		jsonConf = fmt.Appendf(nil, `{
		"name": "com.tailscale.browserext.firefox",
		"description": "Tailscale Browser Extension",
		"path": "%s",
		"type": "stdio",
		"allowed_extensions": [
			"browser-ext@tailscale.com"
		]
	  }`, targetBin)
	default:
		return fmt.Errorf("unknown browser prefix byte %q", browserByte)
	}
	if err := os.WriteFile(targetJSON, jsonConf, 0644); err != nil {
		return err
	}
	log.Printf("wrote registration to %v", targetJSON)
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
	ctx             context.Context // for IPN bus; canceled by cancelCtx
	cancelCtx       context.CancelFunc
	ts              *tsnet.Server
	ln              net.Listener
	wantUp          bool
	// ...
}

func newHost(r io.Reader, w io.Writer) *host {
	h := &host{
		br:   bufio.NewReaderSize(r, 1<<20),
		w:    w,
		logf: log.Printf,
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

	wc, err := lc.WatchIPNBus(h.ctx, ipn.NotifyInitialState|ipn.NotifyRateLimit)
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

func (h *host) userDial(ctx context.Context, netw, addr string) (net.Conn, error) {
	h.mu.Lock()
	sys := h.ts.Sys()
	h.mu.Unlock()

	if sys == nil {
		h.logf("userDial to %v/%v without a tsnet.Server started", netw, addr)
		return nil, fmt.Errorf("no tsnet.Server")
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
				for _, ps := range full.Peer {
					if !ps.ExitNodeOption {
						continue
					}
					name := strings.TrimSuffix(ps.DNSName, ".")
					if name == "" {
						name = ps.HostName
					}
					st.ExitNodes = append(st.ExitNodes, exitNodeInfo{
						Name:     name,
						Online:   ps.Online,
						Selected: ps.ExitNode,
					})
					if ps.ExitNode {
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
	for _, ps := range st.Peer {
		if ps.ExitNode {
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
<title>Tailscale Extension</title>
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
      <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="3" cy="3" r="2.4" fill="#1F1E1E"/><circle cx="10" cy="3" r="2.4" fill="#1F1E1E"/><circle cx="17" cy="3" r="2.4" fill="#1F1E1E"/>
        <circle cx="3" cy="10" r="2.4" fill="#1F1E1E" opacity="0.25"/><circle cx="10" cy="10" r="2.4" fill="#1F1E1E"/><circle cx="17" cy="10" r="2.4" fill="#1F1E1E" opacity="0.25"/>
        <circle cx="3" cy="17" r="2.4" fill="#1F1E1E" opacity="0.25"/><circle cx="10" cy="17" r="2.4" fill="#1F1E1E" opacity="0.25"/><circle cx="17" cy="17" r="2.4" fill="#1F1E1E" opacity="0.25"/>
      </svg>
      <h1>Tailscale Extension</h1>
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
