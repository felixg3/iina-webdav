// WebDAV Browser — Sidebar Webview
// Runs inside IINA's WKWebView. No direct network access (CORS blocked from file://).
// All network requests are delegated to main.js via iina.postMessage / iina.onMessage.

(function () {
  "use strict";

  var state = {
    serverUrl: "",
    startPath: "/",
    currentPath: "/",
    entries: []
  };

  var els = {
    breadcrumb: document.getElementById("breadcrumb"),
    status: document.getElementById("status"),
    fileList: document.getElementById("file-list")
  };

  // --- Init ---

  iina.onMessage("config", function (data) {
    state.serverUrl = (data.serverUrl || "").replace(/\/+$/, "");
    state.startPath = data.startPath || "/";

    if (!state.serverUrl) {
      showStatus("Server not configured.\nSet URL in plugin preferences.", false);
      return;
    }

    navigate(state.startPath);
  });

  // --- IPC: Receive directory listing results from main.js ---

  iina.onMessage("propfind-result", function (data) {
    // Only process if the result matches the current path we're waiting for
    state.entries = data.entries || [];
    render();
  });

  iina.onMessage("propfind-error", function (data) {
    var message = data.message || "Unknown error";
    if (message === "AUTH_FAILED") {
      showStatus("Authentication failed.\nCheck credentials in preferences.", true);
    } else {
      showStatus("Error: " + message, true);
    }
  });

  // Request config from entry script on load
  iina.postMessage("get-config");

  // --- Navigation ---

  function navigate(path) {
    if (!path.startsWith("/")) path = "/" + path;
    state.currentPath = path;
    showLoading();

    // Delegate PROPFIND to main.js (runs outside WKWebView, no CORS issues)
    iina.postMessage("propfind", { path: path });
  }

  // --- Rendering ---

  function render() {
    renderBreadcrumb();
    els.status.textContent = "";
    els.status.className = "status-message";
    els.fileList.innerHTML = "";

    // Filter to directories and video files only
    var visible = state.entries.filter(function (e) {
      return e.isDirectory || e.isVideo;
    });

    if (visible.length === 0) {
      showStatus("No videos or folders here.", false);
      return;
    }

    visible.forEach(function (entry) {
      var li = document.createElement("li");
      li.className = "file-item " + (entry.isDirectory ? "directory" : "video");

      var iconSpan = document.createElement("span");
      iconSpan.className = "icon";
      iconSpan.textContent = entry.isDirectory ? "\uD83D\uDCC1" : "\uD83C\uDFAC";

      var nameSpan = document.createElement("span");
      nameSpan.className = "name";
      nameSpan.textContent = entry.name;

      li.appendChild(iconSpan);
      li.appendChild(nameSpan);

      if (!entry.isDirectory && entry.size > 0) {
        var sizeSpan = document.createElement("span");
        sizeSpan.className = "size";
        sizeSpan.textContent = formatSize(entry.size);
        li.appendChild(sizeSpan);
      }

      if (entry.isDirectory) {
        li.addEventListener("click", function () {
          // Derive path from href
          var path;
          try {
            path = new URL(entry.href, state.serverUrl).pathname;
          } catch (e) {
            path = entry.href;
          }
          navigate(path);
        });
      } else {
        li.addEventListener("click", function () {
          iina.postMessage("play-file", {
            href: entry.href,
            name: entry.name
          });
        });
      }

      els.fileList.appendChild(li);
    });
  }

  function renderBreadcrumb() {
    els.breadcrumb.innerHTML = "";

    var parts = state.currentPath.split("/").filter(Boolean);

    // Root
    var rootSpan = document.createElement("span");
    rootSpan.textContent = "/";
    rootSpan.className = "breadcrumb-item";
    rootSpan.addEventListener("click", function () { navigate("/"); });
    els.breadcrumb.appendChild(rootSpan);

    var accumulated = "";
    parts.forEach(function (part, i) {
      var sep = document.createElement("span");
      sep.textContent = " \u203A ";
      sep.className = "breadcrumb-sep";
      els.breadcrumb.appendChild(sep);

      accumulated += "/" + part;
      var span = document.createElement("span");
      span.textContent = decodeURIComponent(part);

      if (i < parts.length - 1) {
        span.className = "breadcrumb-item";
        var pathForClick = accumulated;
        span.addEventListener("click", function () { navigate(pathForClick); });
      } else {
        span.className = "breadcrumb-item current";
      }

      els.breadcrumb.appendChild(span);
    });
  }

  function showStatus(msg, isError) {
    els.fileList.innerHTML = "";
    els.breadcrumb.innerHTML = "";
    els.status.textContent = msg;
    els.status.className = "status-message" + (isError ? " error" : "");
  }

  function showLoading() {
    els.fileList.innerHTML = "";
    els.status.innerHTML = "";
    els.status.className = "loading";
  }

  // --- Helpers ---

  function formatSize(bytes) {
    if (bytes === 0) return "";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    var val = bytes / Math.pow(1024, i);
    return val.toFixed(i > 0 ? 1 : 0) + " " + units[i];
  }
})();
