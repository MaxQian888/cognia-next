/**
 * Verifies the normalize step that bridges renderer-side `RTCIceServer`
 * shapes into the wire format the Rust `companion_signaling_configure`
 * command expects.
 */

import { normalizeServers } from "./desktop-controller"

describe("normalizeServers", () => {
  it("returns undefined for absent input", () => {
    expect(normalizeServers(undefined)).toBeUndefined()
  })

  it("wraps a single URL string into an array", () => {
    expect(normalizeServers([{ urls: "stun:s.example:3478" }])).toEqual([
      { urls: ["stun:s.example:3478"], username: undefined, credential: undefined },
    ])
  })

  it("preserves multi-URL arrays", () => {
    expect(normalizeServers([{ urls: ["stun:a.example", "stun:b.example"] }])).toEqual([
      { urls: ["stun:a.example", "stun:b.example"], username: undefined, credential: undefined },
    ])
  })

  it("forwards username + credential strings", () => {
    expect(
      normalizeServers([
        {
          urls: "turn:t.example",
          username: "alice",
          credential: "s3cr3t",
        },
      ])
    ).toEqual([{ urls: ["turn:t.example"], username: "alice", credential: "s3cr3t" }])
  })

  it("stringifies non-string credentials (defensive — TURN spec allows oauth tokens)", () => {
    expect(
      normalizeServers([
        {
          urls: "turn:t.example",
          username: "alice",
          // OAuth credential type (object) — keeps the Rust side string-typed
          credential: { value: 42 } as unknown as string,
        },
      ])
    ).toEqual([
      {
        urls: ["turn:t.example"],
        username: "alice",
        credential: "[object Object]",
      },
    ])
  })
})
