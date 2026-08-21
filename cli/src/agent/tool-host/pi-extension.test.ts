/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  digestFile,
  piExtensionOverrideAllowed,
  piExtensionPathForSpawn,
  piExtensionRefusalReason,
  resolvePiExtensionScript,
  verifyPiExtension,
  type PiExtensionVerdict,
} from "./pi-extension"

/** This repo's `ProcessEnv` requires `NODE_ENV`, so build envs through here. */
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ NODE_ENV: "test", ...extra }) as NodeJS.ProcessEnv

const REL = path.join("sidecar", "pi-extension", "cognia-pi-extension.ts")
const INTEGRITY = path.join("sidecar", "pi-extension", "integrity.json")

/** A throwaway dist-shaped tree: <root>/sidecar/pi-extension/{ext,integrity}. */
function makeTree(content: string, pinned?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-pi-ext-"))
  const file = path.join(root, REL)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (pinned !== undefined) {
    fs.writeFileSync(path.join(root, INTEGRITY), JSON.stringify({ sha256: pinned }))
  }
  return { root, file, execPath: path.join(root, "cognia-agent") }
}

describe("resolvePiExtensionScript", () => {
  it("prefers an explicit override", () => {
    expect(
      resolvePiExtensionScript({
        env: env({ COGNIA_PI_EXTENSION_PATH: "/custom/ext.ts" }),
        exists: () => true,
      })
    ).toBe("/custom/ext.ts")
  })

  /**
   * A typo in the override must surface as "the file you named is missing",
   * not silently load a different extension than the operator intended.
   */
  it("returns a non-existent override rather than falling back", () => {
    expect(
      resolvePiExtensionScript({
        env: env({ COGNIA_PI_EXTENSION_PATH: "/typo/ext.ts" }),
        exists: () => false,
      })
    ).toBe("/typo/ext.ts")
  })

  it("finds the packaged copy beside the executable", () => {
    const { root, file, execPath } = makeTree("export default () => {}")
    try {
      expect(resolvePiExtensionScript({ env: env(), execPath })).toBe(file)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns undefined when there is nothing to find", () => {
    expect(
      resolvePiExtensionScript({ env: env(), exists: () => false, execPath: "/nowhere/bin" })
    ).toBeUndefined()
  })

  it("locates the real in-repo extension", () => {
    // Walk-up discovery is what makes a dev checkout work without any env.
    const resolved = resolvePiExtensionScript({ env: env() })
    expect(resolved).toBeDefined()
    expect(fs.existsSync(resolved!)).toBe(true)
  })
})

describe("verifyPiExtension", () => {
  const content = "export default function () {}\n"
  const sha = digestFile("", () => Buffer.from(content))

  it("accepts a file matching its pinned digest", () => {
    const { root, file, execPath } = makeTree(content, sha)
    try {
      expect(verifyPiExtension({ env: env(), execPath })).toEqual({
        status: "ok",
        path: file,
        sha256: sha,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The whole point of the pin. The handshake cannot catch this: a modified
   * extension can still announce itself while holding the permission gate open.
   */
  it("reports a file that does not match its pin as tampered", () => {
    const { root, execPath } = makeTree("export default function () { /* evil */ }\n", sha)
    try {
      const verdict = verifyPiExtension({ env: env(), execPath })
      expect(verdict.status).toBe("tampered")
      expect((verdict as Extract<PiExtensionVerdict, { status: "tampered" }>).expected).toBe(sha)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("reports a missing manifest as unpinned, not as success", () => {
    // Shipping without the manifest is a packaging mistake; treating it as OK
    // would make the pin decorative.
    const { root, execPath } = makeTree(content)
    try {
      expect(verifyPiExtension({ env: env(), execPath }).status).toBe("unpinned")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("reports a corrupt manifest as unpinned", () => {
    const { root, execPath } = makeTree(content)
    fs.writeFileSync(path.join(root, INTEGRITY), "not json")
    try {
      expect(verifyPiExtension({ env: env(), execPath }).status).toBe("unpinned")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("reports a missing extension", () => {
    expect(
      verifyPiExtension({ env: env(), exists: () => false, execPath: "/nowhere/bin" })
    ).toEqual({
      status: "missing",
    })
  })

  it("reports an unreadable extension instead of throwing", () => {
    const verdict = verifyPiExtension({
      env: env({ COGNIA_PI_EXTENSION_PATH: "/x/ext.ts" }),
      readFile: () => {
        throw new Error("EACCES")
      },
    })
    expect(verdict.status).toBe("unreadable")
  })

  it("verifies the real shipped extension against its committed manifest", () => {
    // Guards the repo copy: an edit without `pnpm pi:extension:pin` fails here.
    expect(verifyPiExtension({ env: env() }).status).toBe("ok")
  })
})

describe("piExtensionPathForSpawn", () => {
  it("hands over only a verified extension", () => {
    expect(piExtensionPathForSpawn({ status: "ok", path: "/a", sha256: "x" })).toBe("/a")
  })

  /**
   * Every non-`ok` verdict refuses. The caller turns that into a refused
   * session — NOT into "run without the extension", because Pi ships no
   * permission prompts of its own and its native edit/write/bash tools run with
   * the full rights of the process when nothing intercepts them.
   */
  it("refuses a tampered, missing or unreadable extension", () => {
    expect(
      piExtensionPathForSpawn({ status: "tampered", path: "/a", expected: "x", actual: "y" })
    ).toBeUndefined()
    expect(piExtensionPathForSpawn({ status: "missing" })).toBeUndefined()
    expect(
      piExtensionPathForSpawn({ status: "unreadable", path: "/a", detail: "EACCES" })
    ).toBeUndefined()
  })

  /**
   * `unpinned` used to hand over the path, which made the digest decorative:
   * shipping (or stripping) the manifest was enough to load any file into the
   * role of permission gate. "Cannot be verified" must not reach the same place
   * as "verified".
   */
  it("refuses an unpinned extension instead of trusting it", () => {
    expect(piExtensionPathForSpawn({ status: "unpinned", path: "/a", sha256: "x" })).toBeUndefined()
  })
})

describe("piExtensionRefusalReason", () => {
  it("says nothing for a clean verdict", () => {
    expect(piExtensionRefusalReason({ status: "ok", path: "/a", sha256: "x" })).toBeUndefined()
  })

  it("names the actual cause for every refusal", () => {
    expect(piExtensionRefusalReason({ status: "missing" })).toMatch(/not found/i)
    expect(
      piExtensionRefusalReason({ status: "tampered", path: "/a", expected: "x", actual: "y" })
    ).toMatch(/pinned digest/i)
    expect(piExtensionRefusalReason({ status: "unpinned", path: "/a", sha256: "x" })).toMatch(
      /integrity manifest/i
    )
    expect(
      piExtensionRefusalReason({ status: "unreadable", path: "/a", detail: "EACCES" })
    ).toMatch(/EACCES/)
  })
})

describe("piExtensionOverrideAllowed", () => {
  /**
   * The override exists so a contributor can iterate without re-pinning. In a
   * shipped build it is an env var that swaps out the component holding the
   * permission gate — precisely the substitution the pin exists to prevent.
   */
  it("is a development affordance only", () => {
    expect(piExtensionOverrideAllowed({ NODE_ENV: "production" })).toBe(false)
    expect(piExtensionOverrideAllowed({ NODE_ENV: "development" })).toBe(true)
    expect(piExtensionOverrideAllowed({} as NodeJS.ProcessEnv)).toBe(true)
  })

  it("ignores the override path in production", () => {
    expect(
      resolvePiExtensionScript({
        env: { NODE_ENV: "production", COGNIA_PI_EXTENSION_PATH: "/attacker/ext.ts" },
        exists: () => false,
      })
    ).not.toBe("/attacker/ext.ts")
  })
})
