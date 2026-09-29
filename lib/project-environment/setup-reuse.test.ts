import type {
  ProjectEnvironment,
  ProjectEnvironmentInitialization,
} from "@/types/project-environment"

import {
  MAX_SETUP_REUSE_PATHS,
  assertSetupReuse,
  canonicalJson,
  computeSetupFingerprint,
  effectiveSetupReuse,
  latestSetupRecord,
  recordAllowsReuse,
  setupOutputsPresent,
  setupSignature,
  validateSetupReusePath,
  type SetupReuseIo,
} from "./setup-reuse"

const baseEnvironment: Pick<
  ProjectEnvironment,
  "setupScript" | "variables" | "keyringReferences" | "policy"
> = {
  setupScript: { default: "pnpm install" },
  variables: { NODE_ENV: "development" },
  keyringReferences: [{ variable: "TOKEN", keyringRef: "project:token" }],
  policy: { requiredRuntimeCapabilities: [], network: "on", cacheKey: "1" },
}

function io(files: Record<string, string>, extraStats: Record<string, boolean> = {}): SetupReuseIo {
  return {
    readFile: async (_root, relPath) => {
      if (relPath in files) return files[relPath]
      throw new Error(`missing ${relPath}`)
    },
    statFile: async (_root, relPath) => ({
      exists: relPath in files || extraStats[relPath] === true,
      size: files[relPath]?.length,
      mtimeMs: 1,
    }),
    // Identity "hash" keeps expectations readable; equality is all that matters.
    sha256Hex: async (value) => `h(${value})`,
  }
}

describe("validateSetupReusePath", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm-lock.yaml"],
    ["./package.json", "package.json"],
    ["node_modules/", "node_modules"],
    ["apps\\web\\package.json", "apps/web/package.json"],
  ])("accepts %s as %s", (raw, path) => {
    expect(validateSetupReusePath(raw)).toEqual({ ok: true, path })
  })

  it.each(["", "   ", "/etc/passwd", "C:/Windows", "../outside", "a/../../b", "a//b"])(
    "refuses %p",
    (raw) => {
      expect(validateSetupReusePath(raw)).toEqual({ ok: false })
    }
  )
})

describe("assertSetupReuse", () => {
  it("accepts a valid declaration", () => {
    expect(() =>
      assertSetupReuse({ enabled: true, inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] })
    ).not.toThrow()
  })

  it("refuses a path that leaves the root", () => {
    expect(() => assertSetupReuse({ enabled: true, inputs: ["../x"], outputs: [] })).toThrow(
      /inside the execution root/
    )
  })

  it("refuses an oversized list", () => {
    const inputs = Array.from({ length: MAX_SETUP_REUSE_PATHS + 1 }, (_, i) => `f${i}`)
    expect(() => assertSetupReuse({ enabled: true, inputs, outputs: [] })).toThrow(/at most/)
  })
})

describe("effectiveSetupReuse", () => {
  it("is null when reuse is absent or disabled", () => {
    expect(effectiveSetupReuse({})).toBeNull()
    expect(
      effectiveSetupReuse({ setupReuse: { enabled: false, inputs: ["a"], outputs: [] } })
    ).toBeNull()
  })

  it("drops invalid and duplicate paths and sorts the rest", () => {
    expect(
      effectiveSetupReuse({
        setupReuse: {
          enabled: true,
          inputs: ["b.lock", "./a.lock", "../escape", "a.lock"],
          outputs: ["node_modules/", "/abs"],
        },
      })
    ).toEqual({ enabled: true, inputs: ["a.lock", "b.lock"], outputs: ["node_modules"] })
  })
})

describe("canonicalJson / setupSignature", () => {
  it("is insensitive to key order and undefined fields", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(
      canonicalJson({ a: { d: 2 }, b: 1 })
    )
  })

  it("changes when the script, variables, keyring references or policy change", () => {
    const base = setupSignature(baseEnvironment)
    expect(setupSignature({ ...baseEnvironment, setupScript: { default: "npm ci" } })).not.toBe(
      base
    )
    expect(setupSignature({ ...baseEnvironment, variables: { NODE_ENV: "test" } })).not.toBe(base)
    expect(
      setupSignature({
        ...baseEnvironment,
        keyringReferences: [{ variable: "TOKEN", keyringRef: "project:other" }],
      })
    ).not.toBe(base)
    expect(
      setupSignature({
        ...baseEnvironment,
        policy: { ...baseEnvironment.policy!, cacheKey: "2" },
      })
    ).not.toBe(base)
  })

  it("ignores keyring reference order", () => {
    const two = [
      { variable: "A", keyringRef: "ref:a" },
      { variable: "B", keyringRef: "ref:b" },
    ]
    expect(setupSignature({ ...baseEnvironment, keyringReferences: two })).toBe(
      setupSignature({ ...baseEnvironment, keyringReferences: [...two].reverse() })
    )
  })
})

describe("computeSetupFingerprint", () => {
  const reuse = { enabled: true, inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] }

  it("is stable for unchanged inputs and changes with their content", async () => {
    const signature = setupSignature(baseEnvironment)
    const first = await computeSetupFingerprint(
      signature,
      "/root",
      reuse,
      io({ "pnpm-lock.yaml": "v1" })
    )
    const again = await computeSetupFingerprint(
      signature,
      "/root",
      reuse,
      io({ "pnpm-lock.yaml": "v1" })
    )
    const changed = await computeSetupFingerprint(
      signature,
      "/root",
      reuse,
      io({ "pnpm-lock.yaml": "v2" })
    )
    expect(again).toBe(first)
    expect(changed).not.toBe(first)
  })

  it("treats a missing input as part of the answer", async () => {
    const signature = setupSignature(baseEnvironment)
    const absent = await computeSetupFingerprint(signature, "/root", reuse, io({}))
    const present = await computeSetupFingerprint(
      signature,
      "/root",
      reuse,
      io({ "pnpm-lock.yaml": "" })
    )
    expect(absent).toContain('"content":"absent"')
    expect(present).not.toBe(absent)
  })

  it("falls back to size and mtime for an input that cannot be read as text", async () => {
    const signature = setupSignature(baseEnvironment)
    const fingerprint = await computeSetupFingerprint(
      signature,
      "/root",
      reuse,
      io({}, { "pnpm-lock.yaml": true })
    )
    expect(fingerprint).toContain('"content":"stat:?:1"')
  })

  it("rejects when an input cannot even be stat'ed", async () => {
    const failing: SetupReuseIo = {
      ...io({}),
      statFile: async () => {
        throw new Error("host unavailable")
      },
    }
    await expect(
      computeSetupFingerprint(setupSignature(baseEnvironment), "/root", reuse, failing)
    ).rejects.toThrow("host unavailable")
  })
})

describe("setupOutputsPresent", () => {
  const reuse = { enabled: true, inputs: [], outputs: ["node_modules", ".venv"] }

  it("requires every output", async () => {
    expect(
      await setupOutputsPresent("/r", reuse, io({}, { node_modules: true, ".venv": true }))
    ).toBe(true)
    expect(await setupOutputsPresent("/r", reuse, io({}, { node_modules: true }))).toBe(false)
  })

  it("is trivially true with no declared outputs", async () => {
    expect(
      await setupOutputsPresent("/r", { enabled: true, inputs: [], outputs: [] }, io({}))
    ).toBe(true)
  })
})

describe("latestSetupRecord / recordAllowsReuse", () => {
  const record = (
    overrides: Partial<ProjectEnvironmentInitialization>
  ): ProjectEnvironmentInitialization => ({
    status: "succeeded",
    scope: "managedWorktree",
    executionRoot: "/root",
    startedAt: 1,
    completedAt: 2,
    fingerprint: "fp",
    ...overrides,
  })

  it("picks the latest finished record for the same root and scope", () => {
    const latest = latestSetupRecord(
      {
        initializationHistory: [
          record({ completedAt: 10, fingerprint: "old" }),
          record({ completedAt: 30, executionRoot: "/other" }),
          record({ completedAt: 20, scope: "local" }),
          record({ completedAt: 15, fingerprint: "new" }),
          record({ status: "running", startedAt: 40, completedAt: undefined }),
        ],
      },
      "/root",
      "managedWorktree"
    )
    expect(latest?.fingerprint).toBe("new")
  })

  it("does not let an older success vouch past a later failure", () => {
    const latest = latestSetupRecord(
      {
        initializationHistory: [
          record({ completedAt: 10 }),
          record({ completedAt: 20, status: "failed" }),
        ],
      },
      "/root",
      "managedWorktree"
    )
    expect(recordAllowsReuse(latest, "fp")).toBe(false)
  })

  it("allows reuse only for a success with the same fingerprint", () => {
    expect(recordAllowsReuse(record({}), "fp")).toBe(true)
    expect(recordAllowsReuse(record({}), "other")).toBe(false)
    expect(recordAllowsReuse(record({ fingerprint: undefined }), "fp")).toBe(false)
    expect(recordAllowsReuse(record({ status: "bypassed" }), "fp")).toBe(false)
    expect(recordAllowsReuse(null, "fp")).toBe(false)
  })

  it("considers lastInitialization when history is empty", () => {
    expect(
      latestSetupRecord({ lastInitialization: record({}) }, "/root", "managedWorktree")?.status
    ).toBe("succeeded")
  })
})
