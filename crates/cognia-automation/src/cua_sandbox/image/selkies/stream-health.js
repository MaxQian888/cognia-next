/* Liveness only: never forward input, pixels, URLs, stats or credentials. */
;(() => {
  let observer = null
  let connected = false
  let presented = false
  let failed = null
  let pendingSince = null

  function report() {
    if (!observer) return
    window.parent.postMessage(
      {
        type: "cognia-sandbox-stream-health",
        version: 1,
        nonce: observer.nonce,
        connected,
        presented,
        failed,
      },
      observer.origin === "null" ? "*" : observer.origin
    )
  }

  window.addEventListener("message", (event) => {
    const data = event.data
    if (
      window.parent === window ||
      event.source !== window.parent ||
      !data ||
      data.type !== "cognia-sandbox-stream-observe" ||
      data.version !== 1 ||
      typeof data.nonce !== "string" ||
      !/^[A-Za-z0-9-]{16,128}$/.test(data.nonce)
    )
      return
    observer = { nonce: data.nonce, origin: event.origin }
    pendingSince = null
    report()
  })

  document.addEventListener("visibilitychange", () => {
    pendingSince = null
  })

  window.addEventListener("cognia-selkies-connected", () => {
    connected = true
    presented = false
    failed = null
    pendingSince = null
    report()
  })
  window.addEventListener("cognia-selkies-received", () => {
    if (!document.hidden && pendingSince === null) pendingSince = performance.now()
  })
  window.addEventListener("cognia-selkies-output", () => {
    const first = !presented
    presented = true
    pendingSince = null
    if (first) report()
  })
  for (const kind of ["closed", "error", "decoder-failed", "killed"]) {
    window.addEventListener(`cognia-selkies-${kind}`, () => {
      connected = false
      failed = kind
      report()
    })
  }
  setInterval(() => {
    if (document.hidden) {
      pendingSince = null
      return
    }
    // No chunks on an idle display is healthy. Only outstanding video work
    // without decoder/display-path progress is a stall.
    if (connected && pendingSince !== null && performance.now() - pendingSince > 10_000) {
      failed = "decoder-stalled"
    }
    report()
  }, 1_000)
})()
