// WebDAV Browser — Sidebar Webview
// Runs inside IINA's WKWebView. Has fetch() but no iina.core/mpv access.
// Communicates with main.js via iina.postMessage / iina.onMessage.

(function () {
  "use strict";

  var state = {
    serverUrl: "",
    username: "",
    password: "",
    startPath: "/",
    videoExtensions: [],
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
    state.username = data.username || "";
    state.password = data.password || "";
    state.startPath = data.startPath || "/";
    state.videoExtensions = (data.videoExtensions || "")
      .split(",")
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(Boolean);

    if (!state.serverUrl) {
      showStatus("Server not configured.\nSet URL in plugin preferences.", false);
      return;
    }

    navigate(state.startPath);
  });

  // Request config from entry script on load
  iina.postMessage("get-config");

  // --- WebDAV ---

  function propfind(path) {
    if (!path.endsWith("/")) path += "/";

    var url = state.serverUrl + path;
    var headers = {
      "Depth": "1",
      "Content-Type": "application/xml; charset=utf-8"
    };
    if (state.username) {
      headers["Authorization"] = "Basic " + btoa(state.username + ":" + state.password);
    }

    var body =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<D:propfind xmlns:D="DAV:">\n' +
      "  <D:prop>\n" +
      "    <D:displayname/>\n" +
      "    <D:getcontentlength/>\n" +
      "    <D:getcontenttype/>\n" +
      "    <D:getlastmodified/>\n" +
      "    <D:resourcetype/>\n" +
      "  </D:prop>\n" +
      "</D:propfind>";

    return fetch(url, {
      method: "PROPFIND",
      headers: headers,
      body: body
    }).then(function (response) {
      if (response.status === 401) {
        throw new Error("AUTH_FAILED");
      }
      if (!response.ok && response.status !== 207) {
        throw new Error("HTTP " + response.status + " " + response.statusText);
      }
      return response.text();
    }).then(function (text) {
      return parseResponse(text, path);
    });
  }

  function parseResponse(xmlText, basePath) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(xmlText, "application/xml");
    var ns = "DAV:";

    var responses = doc.getElementsByTagNameNS(ns, "response");
    var entries = [];

    for (var i = 0; i < responses.length; i++) {
      var resp = responses[i];

      var hrefEl = resp.getElementsByTagNameNS(ns, "href")[0];
      var href = hrefEl ? hrefEl.textContent : "";

      // Skip the directory itself
      var decodedHref = decodeURIComponent(href).replace(/\/+$/, "");
      var decodedBase = decodeURIComponent(basePath).replace(/\/+$/, "");
      if (decodedHref === decodedBase) continue;

      var propstat = resp.getElementsByTagNameNS(ns, "propstat")[0];
      var prop = propstat ? propstat.getElementsByTagNameNS(ns, "prop")[0] : null;

      var displaynameEl = prop ? prop.getElementsByTagNameNS(ns, "displayname")[0] : null;
      var contentLengthEl = prop ? prop.getElementsByTagNameNS(ns, "getcontentlength")[0] : null;
      var resourceTypeEl = prop ? prop.getElementsByTagNameNS(ns, "resourcetype")[0] : null;

      var name = displaynameEl && displaynameEl.textContent
        ? displaynameEl.textContent
        : decodeURIComponent(href.split("/").filter(Boolean).pop() || "");

      var isDirectory = resourceTypeEl
        ? resourceTypeEl.getElementsByTagNameNS(ns, "collection").length > 0
        : href.endsWith("/");

      var size = contentLengthEl ? parseInt(contentLengthEl.textContent, 10) : 0;

      entries.push({
        name: name,
        href: href,
        isDirectory: isDirectory,
        size: size,
        isVideo: !isDirectory && isVideoFile(name)
      });
    }

    // Sort: directories first, then alphabetical
    entries.sort(function (a, b) {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return entries;
  }

  function isVideoFile(name) {
    var ext = (name.split(".").pop() || "").toLowerCase();
    return state.videoExtensions.indexOf(ext) !== -1;
  }

  // --- Navigation ---

  function navigate(path) {
    if (!path.startsWith("/")) path = "/" + path;
    state.currentPath = path;
    showLoading();

    propfind(path).then(function (entries) {
      state.entries = entries;
      render();
    }).catch(function (e) {
      if (e.message === "AUTH_FAILED") {
        showStatus("Authentication failed.\nCheck credentials in preferences.", true);
      } else {
        showStatus("Error: " + e.message, true);
      }
    });
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
