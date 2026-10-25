// MV3 service worker for the ADR-0239 WP10 spike.
self.log = []
self.blocking = (() => {
  try {
    chrome.webRequest.onBeforeRequest.addListener(
      () => ({ cancel: false }),
      { urls: ["<all_urls>"] },
      ["blocking"]
    )
    return "accepted"
  } catch (e) {
    return "refused: " + String(e && e.message ? e.message : e)
  }
})()
// Observe-only: what webRequest still sees in MV3.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    const u = new URL(d.url)
    if (u.searchParams.get("s"))
      self.log.push(`webRequest ${d.method} ${d.type} ${u.pathname}?s=${u.searchParams.get("s")}`)
  },
  { urls: ["<all_urls>"] }
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== "Fetch.requestPaused") return
  const u = new URL(params.request.url)
  const s = u.searchParams.get("s")
  const hold =
    params.request.method !== "GET" && !["/fixture", "/bypass", "/frame"].includes(u.pathname)
  if (s)
    self.log.push(
      `${hold ? "HELD" : "paused"} ${params.request.method} ${params.resourceType} ${u.pathname}?s=${s}${source.sessionId ? " child-session" : ""}`
    )
  if (hold) await sleep(300)
  await chrome.debugger.sendCommand(source, "Fetch.continueRequest", {
    requestId: params.requestId,
  })
})
self.holdTab = async (tabId, autoAttach) => {
  await chrome.debugger.attach({ tabId }, "1.3")
  await chrome.debugger.sendCommand({ tabId }, "Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  })
  if (autoAttach) {
    // Child targets (out-of-process iframes, workers) come as sessions.
    chrome.debugger.onEvent.addListener(async (source, method, params) => {
      if (method !== "Target.attachedToTarget") return
      const child = { ...source, sessionId: params.sessionId }
      await chrome.debugger
        .sendCommand(child, "Fetch.enable", {
          patterns: [{ urlPattern: "*", requestStage: "Request" }],
        })
        .catch((e) => self.log.push("child fetch.enable failed " + e))
      await chrome.debugger
        .sendCommand(child, "Runtime.runIfWaitingForDebugger")
        .catch(() => undefined)
    })
    await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    })
  }
  return "attached"
}
self.release = async (tabId) => chrome.debugger.detach({ tabId }).catch(() => undefined)
