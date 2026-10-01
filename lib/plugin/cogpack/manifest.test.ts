import type { CogpackManifestV1 } from "@/types/plugin/plugin-cogset"

import {
  cogpackFilename,
  cogpackSignaturePayload,
  embeddedRelativePath,
  validateCogpackManifest,
} from "./manifest"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const HASH = "a".repeat(64)

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "cognia.cogpack",
    id: "deep-writer",
    version: "1.0.0",
    name: "Deep writer",
    compatibility: { minHostVersion: "0.1.0" },
    members: [
      {
        id: "cognia-pdf",
        name: "PDF",
        version: "0.1.0",
        optional: false,
        source: { kind: "builtin" },
      },
    ],
    ...overrides,
  }
}

function member(source: unknown, extra: Record<string, unknown> = {}) {
  return { id: "tools", name: "Tools", version: "1.2.0", optional: true, source, ...extra }
}

describe("validateCogpackManifest", () => {
  it("accepts every supported source kind", () => {
    const parsed = validateCogpackManifest(
      manifest({
        members: [
          { id: "a", name: "A", version: "1.0.0", optional: false, source: { kind: "builtin" } },
          member({ kind: "github", owner: "acme", repo: "tools", subdir: "./pkg", commit: SHA }),
          { ...member({ kind: "git", url: "https://git.example/x.git", commit: SHA }), id: "g" },
          {
            ...member({
              kind: "registry",
              registryUrl: "https://plugins.cognia.app/api/v1",
              version: "1.2.0",
              checksum: "c",
            }),
            id: "r",
          },
          {
            ...member({ kind: "url", bundleUrl: "https://x.example/a.zip", sha256: HASH }),
            id: "u",
          },
          {
            ...member({
              kind: "openvsx",
              namespace: "acme",
              name: "x.y",
              version: "3.0.0",
              sha256: HASH,
            }),
            id: "acme-x-y",
          },
          {
            ...member({
              kind: "embedded",
              root: "plugins/e",
              files: [{ path: "plugins/e/plugin.json", sha256: HASH, size: 2 }],
            }),
            id: "e",
          },
        ],
      })
    )
    expect(parsed.members.map((m) => m.source.kind)).toEqual([
      "builtin",
      "github",
      "git",
      "registry",
      "url",
      "openvsx",
      "embedded",
    ])
    // Paths are normalized, so what is signed is what is verified.
    expect(parsed.members[1].source).toMatchObject({ subdir: "pkg" })
  })

  it.each([
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ kind: "cognia.template" }, "kind"],
    [{ id: "has space" }, "id must be"],
    [{ version: "1" }, "version must be SemVer"],
    [{ name: "" }, "name must be"],
    [{ compatibility: {} }, "compatibility.minHostVersion"],
    [{ members: [] }, "members must not be empty"],
  ])("refuses %j", (overrides, message) => {
    expect(() => validateCogpackManifest(manifest(overrides))).toThrow(message)
  })

  it.each([
    [member({ kind: "github", owner: "acme", repo: "t", commit: "main" }), "full lowercase commit"],
    [member({ kind: "git", url: "http://insecure/x.git", commit: SHA }), "must use https"],
    [member({ kind: "url", bundleUrl: "https://x/a.zip", sha256: "short" }), "sha256 hex"],
    [member({ kind: "embedded", root: "plugins/other", files: [] }), "root must be plugins/tools"],
    [
      member({
        kind: "embedded",
        root: "plugins/tools",
        files: [{ path: "plugins/tools/index.js", sha256: HASH }],
      }),
      "must include plugins/tools/plugin.json",
    ],
    [
      member({
        kind: "embedded",
        root: "plugins/tools",
        files: [{ path: "plugins/elsewhere/plugin.json", sha256: HASH }],
      }),
      "must be inside plugins/tools/",
    ],
    [member({ kind: "ftp" }), "is not supported"],
    [{ ...member({ kind: "builtin" }), id: "Bad Id" }, "not a valid plugin id"],
    [{ ...member({ kind: "builtin" }), optional: "yes" }, "optional must be a boolean"],
    [
      member({ kind: "builtin" }, { config: { token: "x" }, secretFields: ["token"] }),
      "carries the secret field token",
    ],
    [member({ kind: "builtin" }, { secretFields: ["a", "a"] }), "repeats a field"],
  ])("refuses a bad member %#", (bad, message) => {
    expect(() => validateCogpackManifest(manifest({ members: [bad] }))).toThrow(message)
  })

  it("refuses duplicate members and an unknown signature algorithm", () => {
    const one = member({ kind: "builtin" })
    expect(() => validateCogpackManifest(manifest({ members: [one, one] }))).toThrow(
      "lists tools twice"
    )
    expect(() => validateCogpackManifest(manifest({ signature: { algorithm: "rsa" } }))).toThrow(
      "ed25519"
    )
  })

  it("drops unknown fields rather than passing them through", () => {
    const parsed = validateCogpackManifest(manifest({ extra: "x" })) as unknown as Record<
      string,
      unknown
    >
    expect(parsed).not.toHaveProperty("extra")
  })
})

describe("helpers", () => {
  it("signs the canonical manifest without the signature", () => {
    const base = validateCogpackManifest(manifest()) as CogpackManifestV1
    const signed: CogpackManifestV1 = {
      ...base,
      signature: { algorithm: "ed25519", publisher: "p", publicKey: "k", signature: "s" },
    }
    expect(cogpackSignaturePayload(signed)).toEqual(cogpackSignaturePayload(base))
  })

  it("builds a safe file name and relative embedded paths", () => {
    expect(cogpackFilename({ id: "deep/writer", version: "1.0.0+b" })).toBe(
      "deep_writer-1.0.0_b.cogpack"
    )
    expect(embeddedRelativePath("plugins/x", "plugins/x/dist/a.js")).toBe("dist/a.js")
    expect(() => embeddedRelativePath("plugins/x", "plugins/y/a.js")).toThrow("not inside")
  })
})
