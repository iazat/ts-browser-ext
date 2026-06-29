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

  function renderExitNodes(status) {
    const nodes = status.exitNodes || [];
    if (!status.running || nodes.length === 0) {
      exitNodeRow.hidden = true;
      return;
    }
    exitNodeRow.hidden = false;
    const selected = status.exitNode || "";
    let html = `<option value=""${selected ? "" : " selected"}>None</option>`;
    for (const n of nodes) {
      const machineName = n.name.split(".")[0]; // FQDN -> admin-panel machine name
      const label = machineName + (n.online ? "" : " (offline)");
      const isSel = n.name === selected ? " selected" : "";
      html += `<option value="${n.name}"${isSel}>${label}</option>`;
    }
    exitNodeSelect.innerHTML = html;
  }

  exitNodeSelect.addEventListener("change", () => {
    chrome.runtime.sendMessage({
      command: "setExitNode",
      exitNode: exitNodeSelect.value,
    });
  });
  let isConnected = false;
  let isLoading = true;
  let hasReceivedInitialState = false;

  const port = chrome.runtime.connect({ name: "popup" });

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
        return;
      }
      if (state === "NeedsMachineAuth") {
        stateDisplay.textContent = "Waiting for approval…";
        isLoading = true;
        updateSliderState();
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
      stateDisplay.textContent = status.running
        ? `Connected as ${status.tailnet || "Not connected"}`
        : "Disconnected";
      isConnected = status.running;
      updateSliderState();
      renderExitNodes(status);
    }
  }

  port.onMessage.addListener((msg) => {
    console.log("Received from background:", JSON.stringify(msg));
    if (msg.installCmd) {
      console.log("Received install command");
      stateDisplay.innerHTML = `<b>Installation needed. Run:</b><pre>${msg.installCmd}</pre>`;
      toggleSlider.disabled = true;
      settingsButton.hidden = true;
      return;
    }
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
    chrome.runtime.sendMessage({ command: "toggleProxy" }, (response) => {
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
