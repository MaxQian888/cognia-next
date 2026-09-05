import { buildCanvasSharePath, isLegacyCanvasShareLink, parseCanvasShareLink } from "./share-link"

function query(search: string): URLSearchParams {
  return new URLSearchParams(search)
}

describe("buildCanvasSharePath", () => {
  it("names three identifiers and nothing else", () => {
    // The old link carried the session, its owner, its participants, its
    // permission flags, the document content and the whole operation log.
    const path = buildCanvasSharePath({
      orgId: "org_1",
      workspaceId: "ws_2",
      documentId: "doc_3",
    })
    expect(path).toBe("/canvas/join?org=org_1&workspace=ws_2&document=doc_3")
  })

  it("is relative, so a link cannot point the recipient at another deployment", () => {
    const path = buildCanvasSharePath({ orgId: "o", workspaceId: "w", documentId: "d" })
    expect(path.startsWith("/")).toBe(true)
    expect(path).not.toMatch(/https?:/)
  })

  it("round-trips through the parser", () => {
    const target = { orgId: "org_1", workspaceId: "ws_2", documentId: "doc_3" }
    const parsed = parseCanvasShareLink(query(buildCanvasSharePath(target).split("?")[1]!))
    expect(parsed).toEqual({ ok: true, target })
  })
})

describe("parseCanvasShareLink", () => {
  it("reads a well-formed link", () => {
    expect(parseCanvasShareLink(query("org=o1&workspace=w1&document=d1"))).toEqual({
      ok: true,
      target: { orgId: "o1", workspaceId: "w1", documentId: "d1" },
    })
  })

  it("says 'missing' when the link names nothing", () => {
    // Distinct from 'malformed': one is a bare URL, the other is a link that
    // was tampered with or truncated, and they deserve different advice.
    expect(parseCanvasShareLink(query(""))).toEqual({ ok: false, error: "missing" })
    expect(parseCanvasShareLink(null)).toEqual({ ok: false, error: "missing" })
  })

  it("says 'malformed' when a part is present but unusable", () => {
    expect(parseCanvasShareLink(query("org=o1&workspace=w1"))).toEqual({
      ok: false,
      error: "malformed",
    })
  })

  it("rejects an id that is not an id", () => {
    // These end up in URLs, log lines and request paths.
    for (const bad of [
      "org=../../etc&workspace=w&document=d",
      "org=o&workspace=w w&document=d",
      "org=o&workspace=w&document=<script>",
      "org=o&workspace=w&document=" + "x".repeat(200),
    ]) {
      expect(parseCanvasShareLink(query(bad))).toEqual({ ok: false, error: "malformed" })
    }
  })
})

describe("isLegacyCanvasShareLink", () => {
  it("recognises a link carrying a serialized session", () => {
    expect(isLegacyCanvasShareLink(query("session=eyJhIjoxfQ"))).toBe(true)
  })

  it("recognises a link carrying a server URL", () => {
    // `?server=` was written into persisted settings with `enabled: true` and
    // no validation of scheme or host, so one click pointed the user's
    // collaboration transport at an arbitrary machine.
    expect(isLegacyCanvasShareLink(query("server=ws://attacker.example/x"))).toBe(true)
  })

  it("does not flag a current link", () => {
    expect(isLegacyCanvasShareLink(query("org=o&workspace=w&document=d"))).toBe(false)
    expect(isLegacyCanvasShareLink(null)).toBe(false)
  })
})
