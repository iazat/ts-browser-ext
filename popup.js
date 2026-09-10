var lastStatus;

function browseToURL() {
  if (lastStatus && lastStatus.browseToURL) {
    chrome.tabs.create({ url: lastStatus.browseToURL });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const toggleSlider = document.getElementById("toggleSlider");
  const slider = document.querySelector(".slider");
  const settingsButton = document.getElementById("settingsButton");
  const stateDisplay = document.getElementById("state");
  const exitNodeRow = document.getElementById("exitNodeRow");
  const exitNodeSelect = document.getElementById("exitNodeSelect");

  // renderedExitNodes is a signature of what the picker currently shows, and
  // pendingExitNodes a status whose rendering was put off. The picker's
  // options must not be replaced while the user is in it: a status arrives
  // every few seconds, and rebuilding the list under an open menu makes the
  // browser commit whatever ends up at the clicked position when it closes.
  // That was None — a change event with an empty value, sent to the backend
  // as "stop using an exit node" by a user who had touched nothing.
  let renderedExitNodes = "";
  let pendingExitNodes = null;

  function renderExitNodes(status) {
    const nodes = status.exitNodes || [];
    if (!status.running || nodes.length === 0) {
      exitNodeRow.hidden = true;
      renderedExitNodes = "";
      return;
    }
    exitNodeRow.hidden = false;
    const selected = status.exitNode || "";
    const signature = JSON.stringify([
      !!status.exitNodeResolving,
      selected,
      nodes.map((n) => [n.name, !!n.online]),
    ]);
    if (signature === renderedExitNodes) {
      return; // nothing changed; leave the element alone
    }
    if (document.activeElement === exitNodeSelect) {
      pendingExitNodes = status;
      return;
    }
    renderedExitNodes = signature;
    // None is a claim that no exit node is configured. Just after switching
    // on, the backend can have a selection it cannot name yet — the netmap is
    // still arriving. Saying None there is simply false, and it is the moment
    // the popup is most likely to be open.
    if (status.exitNodeResolving) {
      exitNodeSelect.innerHTML = `<option selected>Connecting…</option>`;
      exitNodeSelect.disabled = true;
      return;
    }
    exitNodeSelect.disabled = false;
    let html = `<option value=""${selected ? "" : " selected"}>None</option>`;
    for (const n of nodes) {
      const machineName = n.name.split(".")[0]; // FQDN -> admin-panel machine name
      const label = machineName + (n.online ? "" : " (offline)");
      const isSel = n.name === selected ? " selected" : "";
      html += `<option value="${n.name}"${isSel}>${label}</option>`;
    }
    exitNodeSelect.innerHTML = html;
  }

  exitNodeSelect.addEventListener("blur", () => {
    if (pendingExitNodes) {
      const status = pendingExitNodes;
      pendingExitNodes = null;
      renderExitNodes(status);
    }
  });

  exitNodeSelect.addEventListener("change", () => {
    chrome.runtime.sendMessage({
      command: "setExitNode",
      exitNode: exitNodeSelect.value,
    });
  });
  let isConnected = false;
  let isLoading = true;
  let hasReceivedInitialState = false;

  // Whether the background has said anything yet. The cached status below and
  // the port race each other, and the cache must not paint over a live answer.
  let painted = false;

  const port = chrome.runtime.connect({ name: "popup" });

  // Paint what was last true before the background gets a chance to answer.
  // The browser discards the worker the background runs in, and the native
  // backend dies with it, so opening this panel can mean waiting out a whole
  // new backend starting Tailscale from cold. Those seconds spent blank read
  // as an extension that is broken rather than one catching up. The spinner
  // stays until something live arrives, so what is on screen is shown as what
  // it is: the last thing known.
  const paintCached = (cached) => {
    if (!cached || !cached.lastStatus || painted || hasReceivedInitialState) {
      return;
    }
    updateStatus(cached.lastStatus);
    isLoading = true; // provisional until the background confirms it
    hasReceivedInitialState = false;
    updateSliderState();
  };
  chrome.storage.local.get("lastStatus", (cached) => {
    if (!chrome.runtime.lastError) paintCached(cached);
  });

  function updateSliderState() {
    if (isLoading) {
      slider.className = "slider loading";
      toggleSlider.checked = true; // Assume connected while loading
      return;
    }
    // Only remove no-transition after we've received and applied the initial state
    if (hasReceivedInitialState) {
      slider.classList.remove("no-transition");
    }
    slider.className = `slider ${isConnected ? "connected" : ""}`;
    toggleSlider.checked = isConnected;
  }

  function updateStatus(status) {
    // The install and error branches disable these, and a status means
    // there is a backend to talk to again.
    toggleSlider.disabled = false;
    settingsButton.hidden = false;
    isLoading = false;
    hasReceivedInitialState = true;
    if (status.error) {
      const m = /^State: (.+)$/.exec(status.error);
      const state = m ? m[1] : null;
      if (state === "Stopped") {
        stateDisplay.textContent = "Disconnected";
        isConnected = false;
        updateSliderState();
        renderExitNodes(status);
        return;
      }
      // Transient states while Tailscale brings the connection up or waits for
      // device approval — show a spinner instead of a scary error.
      if (state === "Starting" || state === "NoState") {
        stateDisplay.textContent = "Connecting…";
        isLoading = true;
        updateSliderState();
        renderExitNodes(status); // hides the picker while nothing is running
        return;
      }
      if (state === "NeedsMachineAuth") {
        stateDisplay.textContent = "Waiting for approval…";
        isLoading = true;
        updateSliderState();
        renderExitNodes(status);
        return;
      }
      stateDisplay.textContent = `Error: ${status.error}`;
      isConnected = false;
      updateSliderState();
      renderExitNodes(status);
      return;
    }
    if (status.needsLogin) {
      lastStatus = status; // so the login click handler can read browseToURL
      stateDisplay.innerHTML = status.browseToURL
        ? `<b><a href='#login' id='loginLink'>Log in</a></b>`
        : "<b>Login required; no URL</b>";
      const loginLink = document.getElementById("loginLink");
      if (loginLink) {
        loginLink.addEventListener("click", (e) => {
          e.preventDefault();
          browseToURL();
        });
      }
      isConnected = false;
      updateSliderState();
      renderExitNodes(status);
      return;
    }
    if (typeof status === "string" && status === "Disconnected") {
      stateDisplay.textContent = "Disconnected";
      isConnected = false;
      updateSliderState();
      return;
    }
    if (status.running !== undefined) {
      // Never render "Connected as Not connected": if the backend is up but
      // has not told us a tailnet name, plain "Connected" is the honest word.
      stateDisplay.textContent = status.running
        ? status.tailnet
          ? `Connected as ${status.tailnet}`
          : "Connected"
        : "Disconnected";
      isConnected = status.running;
      updateSliderState();
      renderExitNodes(status);
      return;
    }
    // A status with nothing in it: the backend is there but has not said a
    // word about itself yet. Rendering none of the above left the panel blank
    // under a toggle that still looked switched on.
    stateDisplay.textContent = "Connecting…";
    isLoading = true;
    updateSliderState();
  }

  port.onMessage.addListener((msg) => {
    console.log("Received from background:", JSON.stringify(msg));
    painted = true;
    if (msg.installCmd) {
      console.log("Received install command");
      stateDisplay.textContent = "";
      const heading = document.createElement("b");
      heading.textContent = "Installation needed. Run:";
      const pre = document.createElement("pre");
      pre.textContent = msg.installCmd;
      stateDisplay.append(heading, pre);
      if (msg.error) {
        // The browser's reason for not having a backend, e.g. "Native host
        // has exited": a host that crashes on start looks the same as one
        // that was never installed, and the fix is different.
        const why = document.createElement("div");
        why.className = "detail";
        why.textContent = msg.error;
        stateDisplay.append(why);
      }
      toggleSlider.disabled = true;
      settingsButton.hidden = true;
      return;
    }
    // The backend went away and the background is bringing up a fresh one.
    // It is not missing, so no install command. The toggle stays usable: a
    // click now is remembered by the background and delivered to the backend
    // that arrives.
    if (msg.reconnecting) {
      console.log("Backend restarting");
      stateDisplay.textContent = "Reconnecting to the backend…";
      isLoading = true;
      updateSliderState();
      toggleSlider.disabled = false;
      settingsButton.hidden = true;
      exitNodeRow.hidden = true;
      return;
    }
    toggleSlider.disabled = false;
    settingsButton.hidden = false;
    if (msg.error) {
      console.log("Error from background:", msg);
      stateDisplay.textContent = msg.error;
      toggleSlider.disabled = true;
      settingsButton.hidden = true;
      return;
    }
    if (msg.status) {
      console.log("Received status update:", msg.status);
      updateStatus(msg.status);
    }
  });

  toggleSlider.addEventListener("change", () => {
    console.log("Toggle slider changed, current state:", isConnected);
    // The state of the switch after the click is what the user asked for. The
    // background used to invert its own idea of the state, and a worker that
    // had just restarted had no idea at all.
    chrome.runtime.sendMessage({ command: "toggleProxy", enable: toggleSlider.checked }, (response) => {
      console.log("Received response from background:", response);
      if (response && response.status) {
        updateStatus(response.status);
      }
    });
    console.log("Sent toggleProxy command to background");
  });

  settingsButton.addEventListener("click", () => {
    console.log("Settings button clicked");
    chrome.tabs.create({ url: "http://100.100.100.100" });
  });

  window.addEventListener("beforeunload", () => {
    port.disconnect();
  });
});
