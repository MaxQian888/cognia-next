jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))
const mockHasNoLeakingPiiDeep = jest.fn((_value?: unknown) => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (value: unknown) => mockHasNoLeakingPiiDeep(value),
}))
const mockRemoteCall = jest.fn()
const mockRemoteTransport = {
  call: (...args: unknown[]) => mockRemoteCall(...args),
  subscribe: jest.fn(() => jest.fn()),
}
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => mockRemoteTransport,
}))
jest.mock("@/lib/claude/ipc", () => ({
  skillsBundleUploadAbort: jest.fn(),
  skillsBundleUploadCommit: jest.fn(),
  skillsBundleUploadOpen: jest.fn(),
  skillsBundleUploadWrite: jest.fn(),
  skillsCatalogGet: jest.fn(),
  skillsInstallAtomic: jest.fn(),
  skillsInstallNative: jest.fn(),
  skillsInstallMirrored: jest.fn(),
  skillsScanNative: jest.fn(),
}))
const mockRemoteState = { activeHostId: null as string | null }
const mockActiveHostSupportsFeature = jest.fn()
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  activeHostSupportsFeature: (...args: unknown[]) => mockActiveHostSupportsFeature(...args),
  useRemoteHostStore: { getState: () => mockRemoteState },
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: null }) },
  resolveSkillBundleMirrors: () => ({ claude: true, codex: true }),
}))
jest.mock("@/lib/db/skills", () => ({
  bulkImportSkills: jest.fn(),
  listSkills: jest.fn(),
  updateSkill: jest.fn(),
  getSkill: jest.fn(),
  persistSkillBundle: jest.fn(),
}))
jest.mock("@/lib/db/skill-resources", () => ({
  listResourcesForSkill: jest.fn(),
  replaceResourcesForSkill: jest.fn(),
}))
jest.mock("@/lib/claude/skills-io", () => ({
  parseSkillMarkdown: jest.fn(),
  serializeSkill: jest.fn(() => "MD"),
  skillFilename: jest.fn((n: string) => `${n}.skill.md`),
}))

import { pushAllToNative, pullAllFromNative, pushOneToNative, suggestedFilename } from "./sync"
import { isTauri } from "@/lib/tauri"
import { skillsCatalogGet, skillsInstallMirrored, skillsScanNative } from "@/lib/claude/ipc"
import {
  bulkImportSkills,
  getSkill,
  listSkills,
  persistSkillBundle,
  updateSkill,
} from "@/lib/db/skills"
import { listResourcesForSkill, replaceResourcesForSkill } from "@/lib/db/skill-resources"
import { parseSkillMarkdown } from "@/lib/claude/skills-io"
import type { Skill, SkillResource } from "@cognia/agent-config-types"

const mockedIsTauri = isTauri as unknown as jest.Mock
const mockedInstall = skillsInstallMirrored as unknown as jest.Mock
const mockedCatalogGet = skillsCatalogGet as unknown as jest.Mock
const mockedScan = skillsScanNative as unknown as jest.Mock
const mockedListSkills = listSkills as unknown as jest.Mock
const mockedUpdateSkill = updateSkill as unknown as jest.Mock
const mockedGetSkill = getSkill as unknown as jest.Mock
const mockedListRes = listResourcesForSkill as unknown as jest.Mock
const mockedReplaceRes = replaceResourcesForSkill as unknown as jest.Mock
const mockedBulk = bulkImportSkills as unknown as jest.Mock
const mockedPersistBundle = persistSkillBundle as unknown as jest.Mock
const mockedParse = parseSkillMarkdown as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockRemoteCall.mockReset()
  mockHasNoLeakingPiiDeep.mockReset().mockReturnValue(true)
  mockRemoteState.activeHostId = null
  mockActiveHostSupportsFeature.mockReturnValue(false)
  // Default `getSkill` resolution: look up the row by id from whatever
  // `listSkills` was mocked to return for the current test. This keeps the
  // pre-existing `pushAllToNative` tests working after the loop body was
  // factored into `pushOneToNative` (which calls `getSkill`).
  mockedGetSkill.mockImplementation(async (id: string) => {
    const last = mockedListSkills.mock.results[mockedListSkills.mock.results.length - 1]
    const rows = (await Promise.resolve(last?.value ?? [])) as Array<{ id: string }>
    return rows.find((r) => r.id === id)
  })
})

describe("suggestedFilename", () => {
  it("delegates to skillFilename", () => {
    expect(suggestedFilename({ name: "x" } as unknown as Skill)).toBe("x.skill.md")
  })
})

describe("pushAllToNative", () => {
  it("rejects writes when neither a desktop nor a capable remote host is active", async () => {
    mockedIsTauri.mockReturnValue(false)
    const r = await pushAllToNative()
    expect(r.errors[0].error).toMatch(/does not support atomic Skill writes/)
  })

  it("uploads and atomically installs a Skill on the active remote host", async () => {
    mockedIsTauri.mockReturnValue(false)
    mockRemoteState.activeHostId = "remote-1"
    mockActiveHostSupportsFeature.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({ id: "c", name: "Custom", source: "custom" })
    mockedListRes.mockResolvedValue([])
    mockRemoteCall.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "skills_bundle_upload_open") {
        return { handleId: "upload-1", chunkBytes: 32768 }
      }
      if (name === "skills_bundle_upload_write") {
        return (args.offset as number) + atob(args.dataBase64 as string).length
      }
      if (name === "host_admin_lease_issue") return { token: "lease-1" }
      if (name === "skills_install_atomic") {
        return {
          targets: [{ target: "cognia", directory: "/remote/skills/custom", writtenFiles: [] }],
        }
      }
      return undefined
    })

    const result = await pushOneToNative("c")

    expect(result.pushed).toBe(1)
    expect(mockRemoteCall).toHaveBeenCalledWith(
      "skills_bundle_upload_open",
      expect.objectContaining({ request: expect.any(Object) })
    )
    expect(mockRemoteCall).toHaveBeenCalledWith(
      "skills_bundle_upload_write",
      expect.objectContaining({ handleId: "upload-1", offset: 0 })
    )
    expect(mockRemoteCall).toHaveBeenCalledWith("skills_bundle_upload_commit", {
      handleId: "upload-1",
      adminLease: "lease-1",
    })
    expect(mockRemoteCall).toHaveBeenCalledWith(
      "skills_install_atomic",
      expect.objectContaining({ handleId: "upload-1", adminLease: "lease-1" })
    )
  })

  it("blocks remote Skill content that fails the renderer PII gate", async () => {
    mockedIsTauri.mockReturnValue(false)
    mockRemoteState.activeHostId = "remote-1"
    mockActiveHostSupportsFeature.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({ id: "c", name: "Custom", source: "custom" })
    mockedListRes.mockResolvedValue([
      {
        skillId: "c",
        kind: "reference",
        path: "contacts.md",
        name: "contacts",
        content: "user@example.com",
        encoding: "utf8",
        size: 16,
      },
    ])
    mockHasNoLeakingPiiDeep.mockReturnValue(false)

    const result = await pushOneToNative("c")

    expect(result.pushed).toBe(0)
    expect(result.errors[0]?.error).toMatch(/renderer PII gate/)
    expect(mockRemoteCall).not.toHaveBeenCalled()
  })

  it("stops a remote transaction if the active host changes between chunks", async () => {
    mockedIsTauri.mockReturnValue(false)
    mockRemoteState.activeHostId = "remote-1"
    mockActiveHostSupportsFeature.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({ id: "c", name: "Custom", source: "custom" })
    mockedListRes.mockResolvedValue([])
    mockRemoteCall.mockImplementation(async (name: string) => {
      if (name === "host_admin_lease_issue") return { token: "lease-1" }
      if (name === "skills_bundle_upload_open") {
        mockRemoteState.activeHostId = "remote-2"
        return { handleId: "upload-1", chunkBytes: 32768 }
      }
      return undefined
    })

    const result = await pushOneToNative("c")

    expect(result.errors[0]?.error).toContain("REMOTE_RESPONSE_STALE")
    expect(mockRemoteCall).toHaveBeenCalledWith("skills_bundle_upload_open", expect.any(Object))
    expect(mockRemoteCall).not.toHaveBeenCalledWith(
      "skills_bundle_upload_write",
      expect.any(Object)
    )
  })

  it("skips builtins and pushes user skills, recording fingerprint", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedListSkills.mockResolvedValue([
      { id: "b", name: "Builtin", isBuiltIn: true },
      { id: "c", name: "Custom", source: "custom" },
      { id: "d", name: "Other", source: "builtin" },
    ])
    mockedListRes.mockResolvedValue([] as SkillResource[])
    mockedInstall.mockResolvedValue({
      targets: [{ target: "cognia", directory: "/dir/Custom", writtenFiles: [] }],
      trashedFrom: null,
    })
    mockedUpdateSkill.mockResolvedValue(undefined)
    const r = await pushAllToNative()
    expect(r.skipped).toBe(2)
    expect(r.pushed).toBe(1)
    expect(mockedUpdateSkill).toHaveBeenCalledWith(
      "c",
      expect.objectContaining({
        nativeDirectory: "/dir/Custom",
        syncOrigin: "frontend",
        lastSyncError: null,
      })
    )
  })

  it("migrates an existing native directory to the stable slug on explicit push", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedListSkills.mockResolvedValue([
      {
        id: "x",
        name: "OldName",
        source: "custom",
        nativeDirectory: "/abs/path/OldDir",
      },
    ])
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockResolvedValue({
      targets: [{ target: "cognia", directory: "/abs/path/OldDir", writtenFiles: [] }],
      trashedFrom: null,
    })
    await pushAllToNative()
    expect(mockedInstall).toHaveBeenCalledWith(
      expect.objectContaining({ dirName: "oldname", clean: true })
    )
  })

  it("falls back to slug when native directory has empty tail", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedListSkills.mockResolvedValue([
      {
        id: "x",
        name: "Edge Case",
        source: "custom",
        nativeDirectory: "trailing/",
      },
    ])
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockResolvedValue({
      targets: [{ target: "cognia", directory: "trailing/", writtenFiles: [] }],
      trashedFrom: null,
    })
    await pushAllToNative()
    expect(mockedInstall).toHaveBeenCalledWith(expect.objectContaining({ dirName: "trailing" }))
  })

  it("captures and reports per-skill errors", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedListSkills.mockResolvedValue([{ id: "c", name: "C", source: "custom" }])
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockRejectedValue(new Error("boom"))
    mockedUpdateSkill.mockResolvedValue(undefined)
    const r = await pushAllToNative()
    expect(r.errors).toEqual([{ name: "C", error: "boom" }])
    expect(mockedUpdateSkill).toHaveBeenCalledWith(
      "c",
      expect.objectContaining({ lastSyncError: "boom" })
    )
  })

  it("captures non-Error rejections", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedListSkills.mockResolvedValue([{ id: "c", name: "C", source: "custom" }])
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockRejectedValue("plain")
    mockedUpdateSkill.mockResolvedValue(undefined)
    const r = await pushAllToNative()
    expect(r.errors[0].error).toBe("plain")
  })

  it("falls back to length-based hash when crypto is unavailable", async () => {
    const orig = (globalThis as unknown as { crypto?: unknown }).crypto
    ;(globalThis as unknown as { crypto?: unknown }).crypto = undefined
    try {
      mockedIsTauri.mockReturnValue(true)
      mockedListSkills.mockResolvedValue([{ id: "c", name: "C", source: "custom" }])
      mockedListRes.mockResolvedValue([
        { path: "x", kind: "file", content: "c" },
      ] as unknown as SkillResource[])
      mockedInstall.mockResolvedValue({
        targets: [{ target: "cognia", directory: "/x", writtenFiles: [] }],
        trashedFrom: null,
      })
      mockedUpdateSkill.mockResolvedValue(undefined)
      const r = await pushAllToNative()
      expect(r.pushed).toBe(1)
    } finally {
      ;(globalThis as unknown as { crypto?: unknown }).crypto = orig
    }
  })

  it("uses crypto.subtle digest when available", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        subtle: {
          digest: async () => new Uint8Array([0xab, 0xcd, 0x01, 0x02]).buffer,
        },
      } as unknown as Crypto,
    })
    try {
      mockedIsTauri.mockReturnValue(true)
      mockedListSkills.mockResolvedValue([{ id: "c", name: "C", source: "custom" }])
      mockedListRes.mockResolvedValue([])
      mockedInstall.mockResolvedValue({
        targets: [{ target: "cognia", directory: "/x", writtenFiles: [] }],
        trashedFrom: null,
      })
      mockedUpdateSkill.mockResolvedValue(undefined)
      const r = await pushAllToNative()
      expect(r.pushed).toBe(1)
      expect(mockedUpdateSkill).toHaveBeenCalledWith(
        "c",
        expect.objectContaining({
          // Hex-encoded SHA-256 from our stubbed digest; first byte 0xab → "ab".
          syncFingerprint: "abcd0102",
        })
      )
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "crypto", originalDescriptor)
      } else {
        delete (globalThis as { crypto?: Crypto }).crypto
      }
    }
  })
})

describe("pullAllFromNative", () => {
  it("rejects reads when neither a desktop nor a capable remote host is active", async () => {
    mockedIsTauri.mockReturnValue(false)
    const r = await pullAllFromNative()
    expect(r.errors[0].error).toMatch(/does not expose its Skills catalog/)
  })

  it("prefers the active remote host's canonical Cognia catalog", async () => {
    mockedIsTauri.mockReturnValue(false)
    mockRemoteState.activeHostId = "remote-1"
    mockActiveHostSupportsFeature.mockReturnValue(true)
    mockedCatalogGet.mockResolvedValue({
      cognia: [{ dirName: "remote", filePath: "/remote", content: "MD", resources: [] }],
      claude: [{ dirName: "claude-only", filePath: "/claude", content: "MD", resources: [] }],
      codex: [],
    })
    mockedListSkills
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "remote-row", name: "Remote" }])
    mockedParse.mockReturnValue({
      draft: { name: "Remote", description: "", content: "MD" },
    })
    mockedBulk.mockResolvedValue({ created: 1 })
    mockedReplaceRes.mockResolvedValue(undefined)

    const result = await pullAllFromNative()

    expect(result.pulled).toBe(1)
    expect(mockedCatalogGet).toHaveBeenCalled()
  })

  it("returns empty result when no native skills", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedScan.mockResolvedValue([])
    const r = await pullAllFromNative()
    expect(r).toEqual({ pushed: 0, pulled: 0, skipped: 0, errors: [] })
  })

  it("creates a fresh row when no local match exists", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedScan.mockResolvedValue([
      {
        dirName: "alpha",
        filePath: "/native/alpha/SKILL.md",
        content: "MD",
        resources: [],
      },
    ])
    mockedListSkills
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "freshly", name: "Alpha" }])
    mockedParse.mockReturnValue({
      draft: { name: "Alpha", description: "d", content: "BODY" },
    })
    mockedBulk.mockResolvedValue({ created: 1 })
    const r = await pullAllFromNative()
    expect(r.pulled).toBe(1)
    expect(mockedBulk).toHaveBeenCalled()
    expect(mockedBulk).toHaveBeenCalledWith([expect.objectContaining({ resources: [] })], "skip")
  })

  it("does not call replaceResourcesForSkill when bulk import created nothing", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedScan.mockResolvedValue([
      {
        dirName: "alpha",
        filePath: "/native/alpha/SKILL.md",
        content: "MD",
        resources: [],
      },
    ])
    mockedListSkills.mockResolvedValueOnce([])
    mockedParse.mockReturnValue({
      draft: { name: "Alpha", content: "BODY" },
    })
    mockedBulk.mockResolvedValue({ created: 0 })
    const r = await pullAllFromNative()
    expect(r.pulled).toBe(1)
    expect(mockedReplaceRes).not.toHaveBeenCalled()
  })

  it("matches by nativeDirectory and updates on stale local row", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedScan.mockResolvedValue([
      {
        dirName: "alpha",
        filePath: "/native/alpha/SKILL.md",
        content: "MD",
        resources: [
          {
            kind: "file",
            path: "x",
            name: "x",
            content: "c",
            encoding: "utf-8",
            size: 1,
          },
        ],
      },
    ])
    const existing = {
      id: "abc",
      name: "Alpha",
      nativeDirectory: "/native/alpha",
      updatedAt: 0,
    }
    mockedListSkills.mockResolvedValueOnce([existing])
    mockedParse.mockReturnValue({
      draft: { name: "Alpha", content: "BODY" },
    })
    const r = await pullAllFromNative()
    expect(r.pulled).toBe(1)
    expect(mockedPersistBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        skill: expect.objectContaining({
          id: "abc",
          name: "Alpha",
          syncOrigin: "native",
          nativeDirectory: "/native/alpha",
        }),
      })
    )
  })

  it("skips update when local row is fresh", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedScan.mockResolvedValue([
      {
        dirName: "alpha",
        filePath: "/native/alpha/SKILL.md",
        content: "MD",
        resources: [],
      },
    ])
    const existing = {
      id: "abc",
      name: "Alpha",
      nativeDirectory: "/native/alpha",
      updatedAt: Date.now() + 60_000, // newer than now
    }
    mockedListSkills.mockResolvedValueOnce([existing])
    mockedParse.mockReturnValue({
      draft: { name: "Alpha", content: "BODY" },
    })
    const r = await pullAllFromNative()
    expect(r.skipped).toBe(1)
    expect(r.pulled).toBe(0)
    expect(mockedUpdateSkill).not.toHaveBeenCalled()
  })

  it("matches by name when nativeDirectory miss", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedScan.mockResolvedValue([
      {
        dirName: "alpha",
        filePath: "/native/alpha\\SKILL.md",
        content: "MD",
        resources: [],
      },
    ])
    const existing = {
      id: "byname",
      name: "Alpha",
      updatedAt: 0,
    }
    mockedListSkills.mockResolvedValueOnce([existing])
    mockedParse.mockReturnValue({
      draft: { name: "Alpha", content: "BODY" },
    })
    const r = await pullAllFromNative()
    expect(r.pulled).toBe(1)
    expect(mockedPersistBundle).toHaveBeenCalledWith(
      expect.objectContaining({ skill: expect.objectContaining({ id: "byname" }) })
    )
  })

  it("captures parse errors per-skill", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedScan.mockResolvedValue([
      {
        dirName: "alpha",
        filePath: "/native/alpha/SKILL.md",
        content: "MD",
        resources: [],
      },
    ])
    mockedListSkills.mockResolvedValue([])
    mockedParse.mockImplementation(() => {
      throw new Error("parse fail")
    })
    const r = await pullAllFromNative()
    expect(r.errors).toEqual([{ name: "alpha", error: "parse fail" }])
  })

  it("captures non-Error parse errors", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedScan.mockResolvedValue([
      {
        dirName: "x",
        filePath: "/x/SKILL.md",
        content: "MD",
        resources: [],
      },
    ])
    mockedListSkills.mockResolvedValue([])
    mockedParse.mockImplementation(() => {
      throw "plain"
    })
    const r = await pullAllFromNative()
    expect(r.errors[0].error).toBe("plain")
  })
})

describe("pushOneToNative", () => {
  it("returns a SyncResult with pushed=1 on success", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({
      id: "c",
      name: "Custom",
      source: "custom",
    })
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockResolvedValue({
      targets: [
        {
          target: "cognia",
          directory: "/data/cognia/skills/custom",
          writtenFiles: [],
        },
        {
          target: "claude",
          directory: "/u/.claude/skills/custom",
          writtenFiles: [],
        },
      ],
      trashedFrom: null,
    })
    mockedUpdateSkill.mockResolvedValue(undefined)
    const result = await pushOneToNative("c")
    expect(result.pushed).toBe(1)
    expect(result.errors).toEqual([])
    expect(mockedUpdateSkill).toHaveBeenCalledWith(
      "c",
      expect.objectContaining({
        // Cognia outcome wins — that's the canonical directory the row
        // should track. The Claude / Codex mirrors are throwaway.
        nativeDirectory: "/data/cognia/skills/custom",
        syncOrigin: "frontend",
        lastSyncError: null,
      })
    )
    expect(mockedInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: ["cognia", "claude", "codex"],
        trashBeforeClean: false,
      })
    )
  })

  it("skips the IPC write entirely when the recorded fingerprint matches the freshly computed value", async () => {
    mockedIsTauri.mockReturnValue(true)
    // Compute the fingerprint the implementation would compute for this
    // (skill, []) pair so we can pre-stamp it on the row.
    const { fingerprint } = await import("./sync")
    const skill = {
      id: "c",
      name: "Custom",
      source: "custom",
      nativeDirectory: "/data/cognia/skills/custom",
    }
    const fp = await fingerprint(skill as never, [])
    mockedGetSkill.mockResolvedValue({
      ...skill,
      syncFingerprint: fp,
    })
    mockedListRes.mockResolvedValue([])
    const result = await pushOneToNative("c")
    expect(result.skipped).toBe(1)
    expect(result.pushed).toBe(0)
    expect(mockedInstall).not.toHaveBeenCalled()
  })

  it("requests trashBeforeClean when the recorded fingerprint differs from the freshly computed value", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({
      id: "c",
      name: "Custom",
      source: "custom",
      nativeDirectory: "/data/cognia/skills/custom",
      syncFingerprint: "stale-fp",
    })
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockResolvedValue({
      targets: [{ target: "cognia", directory: "/data/cognia/skills/custom", writtenFiles: [] }],
      trashedFrom: "/data/cognia/skills/.trash/custom-1700000000",
    })
    mockedUpdateSkill.mockResolvedValue(undefined)
    await pushOneToNative("c")
    expect(mockedInstall).toHaveBeenCalledWith(expect.objectContaining({ trashBeforeClean: true }))
  })

  it("returns errors=[error] and writes lastSyncError on failure", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({
      id: "c",
      name: "Custom",
      source: "custom",
    })
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockRejectedValue(new Error("disk full"))
    mockedUpdateSkill.mockResolvedValue(undefined)
    const result = await pushOneToNative("c")
    expect(result.pushed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toEqual({ name: "Custom", error: "disk full" })
    expect(mockedUpdateSkill).toHaveBeenCalledWith(
      "c",
      expect.objectContaining({ lastSyncError: "disk full" })
    )
  })

  it("returns a single (env) error in web mode", async () => {
    mockedIsTauri.mockReturnValue(false)
    const result = await pushOneToNative("c")
    expect(result.errors[0]).toMatchObject({ name: "(env)" })
    expect(mockedGetSkill).not.toHaveBeenCalled()
  })

  it("returns skipped=1 for built-in skills", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({
      id: "b",
      name: "Built-in",
      source: "builtin",
      isBuiltIn: true,
    })
    const result = await pushOneToNative("b")
    expect(result.skipped).toBe(1)
    expect(result.pushed).toBe(0)
    expect(mockedInstall).not.toHaveBeenCalled()
  })

  it("returns a 'not found' error when the skill is missing", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue(undefined)
    const result = await pushOneToNative("missing")
    expect(result.errors).toEqual([{ name: "missing", error: "Skill not found." }])
  })

  it("uses the stable slug instead of preserving a stale directory tail", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({
      id: "x",
      name: "OldName",
      source: "custom",
      nativeDirectory: "/abs/path/OldDir",
      // No prior fingerprint → precheck doesn't short-circuit.
      syncFingerprint: undefined,
    })
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockResolvedValue({
      targets: [{ target: "cognia", directory: "/abs/path/OldDir", writtenFiles: [] }],
      trashedFrom: null,
    })
    await pushOneToNative("x")
    expect(mockedInstall).toHaveBeenCalledWith(
      expect.objectContaining({ dirName: "oldname", clean: true })
    )
  })

  it("captures non-Error rejections from the IPC layer", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedGetSkill.mockResolvedValue({
      id: "c",
      name: "Custom",
      source: "custom",
    })
    mockedListRes.mockResolvedValue([])
    mockedInstall.mockRejectedValue("plain")
    mockedUpdateSkill.mockResolvedValue(undefined)
    const result = await pushOneToNative("c")
    expect(result.errors[0].error).toBe("plain")
  })
})
