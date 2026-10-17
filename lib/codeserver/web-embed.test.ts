import { codeServerWorkbenchUrl, hostIsThisMachine, resolveWebWorkbenchTarget } from "./web-embed"
import type { CodeServerStatus } from "@/lib/codeserver/client"

function status(over: Partial<CodeServerStatus> = {}): CodeServerStatus {
  return { running: true, port: 41234, version: "1.0.0", ...over }
}

describe("codeServerWorkbenchUrl", () => {
  it.each([
    "/work/ai",
    "/work/ai worktrees/fe9049fb2becd464d95808ef",
    "/work/中文 #1?draft&mode=native%",
    "C:\\work\\ai project",
  ])("preserves the selected root in the folder query: %s", (root) => {
    const url = new URL(codeServerWorkbenchUrl(41234, root))
    expect(url.origin).toBe("http://127.0.0.1:41234")
    expect(url.pathname).toBe("/")
    expect(url.searchParams.get("folder")).toBe(root)
    expect([...url.searchParams.keys()]).toEqual(["folder"])
    expect(url.hash).toBe("")
  })
})

describe("hostIsThisMachine", () => {
  it("treats no pairing as this machine, because then this shell IS the host", () => {
    expect(hostIsThisMachine(null)).toBe(true)
  })

  it("accepts every loopback spelling, brackets included", () => {
    for (const url of [
      "http://127.0.0.1:27891",
      "http://localhost:27891",
      "https://127.9.9.9:27890",
      "http://[::1]:27891",
    ]) {
      expect(hostIsThisMachine(url)).toBe(true)
    }
  })

  it("rejects anything else, including a name that merely contains localhost", () => {
    for (const url of [
      "https://192.168.1.20:27890",
      "https://host.example.com:27890",
      "https://localhost.evil.example:27890",
      "https://127.0.0.1.evil.example:27890",
    ]) {
      expect(hostIsThisMachine(url)).toBe(false)
    }
  })

  it("treats an unparseable base URL as remote rather than guessing", () => {
    // Guessing permissively here points an iframe at this machine's loopback
    // on the strength of a string nobody could parse.
    expect(hostIsThisMachine("not a url")).toBe(false)
  })
})

describe("resolveWebWorkbenchTarget", () => {
  it("embeds the host's loopback port when the host is this machine", () => {
    expect(
      resolveWebWorkbenchTarget({
        root: "/repo",
        status: status(),
        hostBaseUrl: "http://127.0.0.1:27891",
      })
    ).toEqual({ kind: "embed", url: "http://127.0.0.1:41234/?folder=%2Frepo" })
  })

  it("uses the loopback literal, not the name the pairing was made under", () => {
    // The port was disclosed because the host is on this machine, so the
    // address that is true is 127.0.0.1 whatever the endpoint was called.
    expect(
      resolveWebWorkbenchTarget({
        root: "/repo",
        status: status(),
        hostBaseUrl: "http://localhost:27891",
      })
    ).toEqual({ kind: "embed", url: "http://127.0.0.1:41234/?folder=%2Frepo" })
  })

  it("says nothing is running rather than offering a dead frame", () => {
    expect(
      resolveWebWorkbenchTarget({
        root: "/repo",
        status: status({ running: false, port: null }),
        hostBaseUrl: null,
      })
    ).toEqual({ kind: "unavailable", reason: "not-running" })
    expect(resolveWebWorkbenchTarget({ root: "/repo", status: null, hostBaseUrl: null })).toEqual({
      kind: "unavailable",
      reason: "not-running",
    })
  })

  it("refuses to embed another machine's workbench even if a port leaked", () => {
    // Defence in depth: the host only discloses a port on its loopback plane,
    // so a port arriving alongside a remote endpoint is already wrong. Framing
    // it would point at THIS machine's port 41234, which is somebody else's
    // process entirely.
    expect(
      resolveWebWorkbenchTarget({
        root: "/repo",
        status: status(),
        hostBaseUrl: "https://192.168.1.20:27890",
      })
    ).toEqual({ kind: "unavailable", reason: "needs-host-browser" })
  })

  it("asks for a browser on the host when the port was withheld", () => {
    // Same machine, but this browser did not arrive over the plaintext
    // loopback listener, so there is no second way in: the relay needs a
    // bearer token that neither an iframe nor a top-level navigation can send.
    expect(
      resolveWebWorkbenchTarget({
        root: "/repo",
        status: status({ port: null }),
        hostBaseUrl: "http://127.0.0.1:27891",
      })
    ).toEqual({ kind: "unavailable", reason: "needs-host-browser" })
  })
})
