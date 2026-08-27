import { toWebSocketBase } from "./ws-url"

it("maps each scheme to its own WebSocket equivalent", () => {
  expect(toWebSocketBase("https://cognia.localhost")).toBe("wss://cognia.localhost")
  expect(toWebSocketBase("http://127.0.0.1:27891")).toBe("ws://127.0.0.1:27891")
})

it("does not upgrade a plaintext host to TLS", () => {
  // The bug this file exists to prevent: a single /^https?/ → "wss" rewrite
  // sends a TLS handshake to the plaintext browser-access listener, which
  // fails only on the event stream while RPC keeps working.
  expect(toWebSocketBase("http://localhost:27891")).not.toContain("wss:")
})

it("keeps path, port and query intact", () => {
  expect(toWebSocketBase("https://host:8443/base?x=1")).toBe("wss://host:8443/base?x=1")
})

it("leaves a non-http scheme alone", () => {
  expect(toWebSocketBase("wss://already-upgraded")).toBe("wss://already-upgraded")
  expect(toWebSocketBase("ws://already-plain")).toBe("ws://already-plain")
})

it("only rewrites at the start, not inside the authority", () => {
  expect(toWebSocketBase("https://https.example.com/http:")).toBe("wss://https.example.com/http:")
})
