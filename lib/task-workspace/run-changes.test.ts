import {
  CHANGE_DIFF_AVAILABILITIES,
  RUN_CHANGE_KINDS,
  isSensitiveResourcePath,
  projectPatchSetChanges,
  type ChangeDiffAvailability,
} from "./run-changes"
import type { ChangeKind, PatchSet } from "./types"

type Covers<Union extends string, List extends readonly string[]> =
  Exclude<Union, List[number]> extends never ? true : never

/** Fails to compile if a union member has no entry in the exported list. */
const availabilitiesCovered: Covers<ChangeDiffAvailability, typeof CHANGE_DIFF_AVAILABILITIES> =
  true
const kindsCovered: Covers<ChangeKind, typeof RUN_CHANGE_KINDS> = true

type PatchFile = PatchSet["files"][number]

function hunk(over: Partial<PatchFile["hunks"][number]> = {}): PatchFile["hunks"][number] {
  return {
    id: "hunk:1:abc",
    header: "@@ -1,2 +1,3 @@",
    forwardPatchHash: "f",
    inversePatchHash: "i",
    additions: 2,
    deletions: 1,
    ...over,
  }
}

function file(over: Partial<PatchFile> = {}): PatchFile {
  return {
    path: "src/app.ts",
    oldPath: null,
    kind: "modified",
    resourceKind: "file",
    beforeHash: "b",
    afterHash: "a",
    beforeMode: 33188,
    afterMode: 33188,
    binary: false,
    hunks: [hunk()],
    ...over,
  }
}

function patchSet(files: PatchFile[]): PatchSet {
  return {
    patchId: "patch:1",
    taskId: "task:1",
    runId: "run:s1:2",
    state: "ready",
    baseRevision: 4,
    appliedRevision: null,
    reversible: true,
    files,
    createdAt: 1_700_000_000_000,
  }
}

describe("isSensitiveResourcePath", () => {
  it.each([
    ".env",
    "app/.env",
    ".env.local",
    "config/credentials.json",
    "credentials.yaml",
    "credentials.yml",
    "keys/id_rsa",
    "id_ed25519",
    ".ssh/known_hosts",
    "certs/server.pem",
    "certs/server.key",
    "bundle.p12",
    "bundle.pfx",
  ])("treats %s as sensitive", (path) => {
    expect(isSensitiveResourcePath(path)).toBe(true)
  })

  it.each(["src/env.ts", "README.md", "environment.tsx", "a/keyboard.ts", "notes.keynote"])(
    "leaves %s alone",
    (path) => {
      expect(isSensitiveResourcePath(path)).toBe(false)
    }
  )

  it("normalizes Windows separators and case", () => {
    expect(isSensitiveResourcePath("App\\Config\\.ENV")).toBe(true)
    expect(isSensitiveResourcePath("certs\\Server.PEM")).toBe(true)
  })

  it("does not treat a leading-dot name as an extension match", () => {
    // ".key" is a dotfile named `.key`, not a file with a `key` extension —
    // `lastIndexOf(".") <= 0` guards it. It is still not sensitive by name.
    expect(isSensitiveResourcePath(".key")).toBe(false)
  })
})

describe("projectPatchSetChanges", () => {
  it("marks a modified text file with hunks as available and counts its lines", () => {
    const result = projectPatchSetChanges(patchSet([file()]))
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "src/app.ts",
        kind: "modified",
        availability: "available",
        hunkCount: 1,
        stats: { additions: 2, deletions: 1 },
      }),
    ])
    expect(result.totals).toEqual({ files: 1, additions: 2, deletions: 1, withheld: 0 })
  })

  it("reports a created file as noTextDiff and omits stats rather than claiming +0 -0", () => {
    const result = projectPatchSetChanges(
      patchSet([file({ path: "src/new.ts", kind: "created", hunks: [] })])
    )
    expect(result.files[0].availability).toBe("noTextDiff")
    expect(result.files[0].stats).toBeUndefined()
    expect(result.files[0].hunkCount).toBe(0)
    expect(result.totals.withheld).toBe(1)
  })

  it("reports binary and symlink changes without asking for a body", () => {
    const result = projectPatchSetChanges(
      patchSet([
        file({ path: "assets/logo.png", binary: true, hunks: [] }),
        file({ path: "bin/current", resourceKind: "symlink", hunks: [] }),
      ])
    )
    expect(result.files.map((entry) => entry.availability)).toEqual(["binary", "symlink"])
    expect(result.totals.withheld).toBe(2)
  })

  it("withholds a sensitive path even when the ledger did store hunks for it", () => {
    // The ledger keeps hunks for a modified `.env` like any other text file;
    // the host would refuse the body, and this surface must not ask.
    const result = projectPatchSetChanges(patchSet([file({ path: "app/.env" })]))
    expect(result.files[0].availability).toBe("sensitive")
    expect(result.totals).toEqual({ files: 1, additions: 0, deletions: 0, withheld: 1 })
  })

  it("keeps a withheld file's lines out of the totals", () => {
    const result = projectPatchSetChanges(
      patchSet([
        file({ path: "src/a.ts", hunks: [hunk({ additions: 3, deletions: 0 })] }),
        file({ path: "app/.env", hunks: [hunk({ additions: 9, deletions: 9 })] }),
      ])
    )
    expect(result.totals).toEqual({ files: 2, additions: 3, deletions: 0, withheld: 1 })
  })

  it("sums every hunk of a file and tolerates missing counts", () => {
    const result = projectPatchSetChanges(
      patchSet([
        file({
          hunks: [
            hunk({ additions: 1, deletions: 2 }),
            hunk({ id: "hunk:2:def", additions: undefined, deletions: undefined }),
            hunk({ id: "hunk:3:ghi", additions: 4, deletions: 0 }),
          ],
        }),
      ])
    )
    expect(result.files[0].stats).toEqual({ additions: 5, deletions: 2 })
    expect(result.files[0].hunkCount).toBe(3)
  })

  it("carries the rename origin and sorts by path", () => {
    const result = projectPatchSetChanges(
      patchSet([
        file({ path: "z.ts" }),
        file({ path: "a.ts", kind: "renamed", oldPath: "old/a.ts", hunks: [] }),
      ])
    )
    expect(result.files.map((entry) => entry.path)).toEqual(["a.ts", "z.ts"])
    expect(result.files[0].oldPath).toBe("old/a.ts")
    expect(result.files[0].availability).toBe("noTextDiff")
  })

  it("carries the run id so the surface can key expansion to the right turn", () => {
    const result = projectPatchSetChanges(patchSet([]))
    expect(result.runId).toBe("run:s1:2")
    expect(result.totals).toEqual({ files: 0, additions: 0, deletions: 0, withheld: 0 })
  })

  it("exports label-coverage lists that match their unions", () => {
    expect(availabilitiesCovered).toBe(true)
    expect(kindsCovered).toBe(true)
    expect(CHANGE_DIFF_AVAILABILITIES).toHaveLength(5)
    expect(RUN_CHANGE_KINDS).toHaveLength(4)
  })
})
