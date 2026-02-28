// WebDAV Browser — IINA Entry Script
// Runs in IINA's JSC runtime (no DOM). Has full iina.* API access.
// Communicates with sidebar webview via postMessage/onMessage.

const { core, sidebar, console, event, preferences, mpv } = iina;

console.log("WebDAV Browser plugin loaded");

event.on("iina.window-loaded", () => {
  sidebar.loadFile("sidebar.html");

  // Send config to sidebar when requested
  sidebar.onMessage("get-config", () => {
    sidebar.postMessage("config", {
      serverUrl: preferences.get("serverUrl") || "",
      username: preferences.get("username") || "",
      password: preferences.get("password") || "",
      startPath: preferences.get("startPath") || "/",
      videoExtensions: preferences.get("videoExtensions") || ""
    });
  });

  // Play a video file
  sidebar.onMessage("play-file", (data) => {
    const serverUrl = preferences.get("serverUrl") || "";
    const username = preferences.get("username") || "";
    const password = preferences.get("password") || "";
    const href = data.href;
    const name = data.name;

    // Resolve href to absolute URL
    let playUrl;
    try {
      if (href.startsWith("http://") || href.startsWith("https://")) {
        playUrl = new URL(href);
      } else {
        playUrl = new URL(href, serverUrl);
      }
    } catch (e) {
      // Fallback: concatenate
      playUrl = new URL(serverUrl.replace(/\/+$/, "") + href);
    }

    // Embed credentials for mpv/ffmpeg HTTP basic auth
    if (username) {
      playUrl.username = username;
      playUrl.password = password;
    }

    const urlString = playUrl.toString();
    console.log("Playing: " + name);

    core.open(urlString);
    core.osd("Playing: " + name);
  });
});
