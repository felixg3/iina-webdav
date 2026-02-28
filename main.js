// WebDAV Browser — IINA Entry Script
// Runs in IINA's JSC runtime (no DOM). Has full iina.* API access.
// Communicates with sidebar webview via postMessage/onMessage.
//
// All network requests (PROPFIND) are handled here using utils.exec("curl")
// because iina.http only supports standard methods (GET/POST/PUT/PATCH/DELETE)
// and WKWebView blocks cross-origin fetch() from file:// origins.

const { core, sidebar, console, event, preferences, utils } = iina;

console.log("WebDAV Browser plugin loaded");

// --- Config helpers ---

function getConfig() {
  return {
    serverUrl: (preferences.get("serverUrl") || "").replace(/\/+$/, ""),
    username: preferences.get("username") || "",
    password: preferences.get("password") || "",
    startPath: preferences.get("startPath") || "/",
    videoExtensions: preferences.get("videoExtensions") || ""
  };
}

function getVideoExtensions() {
  var raw = preferences.get("videoExtensions") || "";
  return raw.split(",")
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}

function isVideoFile(name) {
  var exts = getVideoExtensions();
  var ext = (name.split(".").pop() || "").toLowerCase();
  return exts.indexOf(ext) !== -1;
}

// --- WebDAV PROPFIND via curl ---

function propfind(path) {
  var config = getConfig();
  if (!config.serverUrl) {
    return Promise.reject(new Error("Server not configured."));
  }

  if (!path.endsWith("/")) path += "/";
  var url = config.serverUrl + path;

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

  // Build curl arguments for PROPFIND
  var args = [
    "-s",           // silent
    "-S",           // show errors
    "-X", "PROPFIND",
    "-H", "Depth: 1",
    "-H", "Content-Type: application/xml; charset=utf-8",
    "-d", body,
    "-w", "\n%{http_code}"  // append HTTP status code
  ];

  // Add basic auth if configured
  if (config.username) {
    args.push("-u");
    args.push(config.username + ":" + config.password);
  }

  args.push(url);

  return utils.exec("curl", args).then(function (result) {
    if (result.status !== 0) {
      throw new Error("curl failed: " + (result.stderr || "exit " + result.status));
    }

    var output = result.stdout || "";

    // Extract HTTP status code from the last line (added by -w)
    var lastNewline = output.lastIndexOf("\n");
    var httpStatus = 0;
    var xmlText = output;

    if (lastNewline >= 0) {
      var statusStr = output.substring(lastNewline + 1).trim();
      httpStatus = parseInt(statusStr, 10) || 0;
      xmlText = output.substring(0, lastNewline);
    }

    if (httpStatus === 401) {
      throw new Error("AUTH_FAILED");
    }
    if (httpStatus !== 207 && httpStatus !== 200) {
      throw new Error("HTTP " + httpStatus);
    }

    return parseResponse(xmlText, path);
  });
}

// --- XML Parsing (regex-based, no DOMParser in JSC) ---

function parseResponse(xmlText, basePath) {
  var entries = [];

  // Split into <d:response> or <D:response> blocks
  var responseBlocks = xmlText.split(/<(?:d|D):response[\s>]/);

  for (var i = 1; i < responseBlocks.length; i++) {
    var block = responseBlocks[i];

    // Extract href
    var hrefMatch = block.match(/<(?:d|D):href[^>]*>([\s\S]*?)<\/(?:d|D):href>/);
    var href = hrefMatch ? hrefMatch[1].trim() : "";

    if (!href) continue;

    // Skip the directory itself
    var decodedHref = decodeURIComponent(href).replace(/\/+$/, "");
    var decodedBase = decodeURIComponent(basePath).replace(/\/+$/, "");
    if (decodedHref === decodedBase) continue;

    // Extract displayname
    var displaynameMatch = block.match(/<(?:d|D):displayname[^>]*>([\s\S]*?)<\/(?:d|D):displayname>/);
    var displayname = displaynameMatch ? displaynameMatch[1].trim() : "";

    // Derive name from displayname or href
    var name = displayname || decodeURIComponent(href.split("/").filter(Boolean).pop() || "");

    // Check if it's a collection (directory)
    var isDirectory = /<(?:d|D):collection\s*\/?>/.test(block);

    // Extract content length
    var contentLengthMatch = block.match(/<(?:d|D):getcontentlength[^>]*>([\s\S]*?)<\/(?:d|D):getcontentlength>/);
    var size = contentLengthMatch ? parseInt(contentLengthMatch[1].trim(), 10) : 0;
    if (isNaN(size)) size = 0;

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

// --- Event handlers ---

event.on("iina.window-loaded", function () {
  sidebar.loadFile("sidebar.html");

  // Send config to sidebar when requested
  sidebar.onMessage("get-config", function () {
    sidebar.postMessage("config", getConfig());
  });

  // Handle PROPFIND requests from sidebar
  sidebar.onMessage("propfind", function (data) {
    var path = (data && data.path) || "/";

    propfind(path).then(function (entries) {
      sidebar.postMessage("propfind-result", {
        path: path,
        entries: entries
      });
    }).catch(function (e) {
      sidebar.postMessage("propfind-error", {
        path: path,
        message: e.message || String(e)
      });
    });
  });

  // Play a video file
  sidebar.onMessage("play-file", function (data) {
    var config = getConfig();
    var href = data.href;
    var name = data.name;

    // Resolve href to absolute URL
    var playUrl;
    try {
      if (href.startsWith("http://") || href.startsWith("https://")) {
        playUrl = new URL(href);
      } else {
        playUrl = new URL(href, config.serverUrl);
      }
    } catch (e) {
      // Fallback: concatenate
      playUrl = new URL(config.serverUrl.replace(/\/+$/, "") + href);
    }

    // Embed credentials for mpv/ffmpeg HTTP basic auth
    if (config.username) {
      playUrl.username = config.username;
      playUrl.password = config.password;
    }

    var urlString = playUrl.toString();
    console.log("Playing: " + name);

    core.open(urlString);
    core.osd("Playing: " + name);
  });
});
