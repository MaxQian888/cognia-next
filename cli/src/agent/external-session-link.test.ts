/**
 * @jest-environment node
 */
import {
  externalLinkPath,
  isResumableLink,
  readExternalLink,
  resumeContinuityNotice,
  writeExternalLink,
} from "./external-session-link"
import type { TranscriptFs } from "./transcript"

function memoryFs(seed: Record<string, string> = {}) {
  const files = { ...seed }
  const fs: TranscriptFs = {
    append: (p, line) => {
      files[p] = (files[p] ?? "") + line
    },
    read: (p) => files[p] ?? null,
    mkdirp: () => undefined,
    write: (p, content) => {
      files[p] = content
    },
  }
  return { fs, files }
}

const HOME = "/home/.cognia"

describe("externalLinkPath", () => {
  it("sits beside the transcript so the two travel together", () => {
    expect(externalLinkPath(HOME, "s1")).toBe("/home/.cognia/sessions/s1.external.json")
  })
})

describe("writeExternalLink / readExternalLink", () => {
  it("round-trips the backend and the agent's own session id", () => {
    const { fs } = memoryFs()
    writeExternalLink(HOME, "s1", { backend: "codex", externalSessionId: "acp-7" }, fs)
    expect(readExternalLink(HOME, "s1", fs)).toEqual({
      backend: "codex",
      externalSessionId: "acp-7",
    })
  })

  it("overwrites rather than appending, so the newest id wins", () => {
    const { fs } = memoryFs()
    writeExternalLink(HOME, "s1", { backend: "codex", externalSessionId: "old" }, fs)
    writeExternalLink(HOME, "s1", { backend: "codex", externalSessionId: "new" }, fs)
    expect(readExternalLink(HOME, "s1", fs)?.externalSessionId).toBe("new")
  })

  it("never throws on an unwritable home — a lost link costs a resume, not a turn", () => {
    const fs: TranscriptFs = {
      append: () => undefined,
      read: () => null,
      mkdirp: () => {
        throw new Error("EROFS")
      },
      write: () => undefined,
    }
    expect(() =>
      writeExternalLink(HOME, "s1", { backend: "codex", externalSessionId: "x" }, fs)
    ).not.toThrow()
  })

  it("reports nothing for a missing, corrupt or incomplete record", () => {
    expect(readExternalLink(HOME, "s1", memoryFs().fs)).toBeUndefined()

    const corrupt = memoryFs({ [externalLinkPath(HOME, "s1")]: "{not json" })
    expect(readExternalLink(HOME, "s1", corrupt.fs)).toBeUndefined()

    const partial = memoryFs({
      [externalLinkPath(HOME, "s1")]: JSON.stringify({ backend: "codex" }),
    })
    expect(readExternalLink(HOME, "s1", partial.fs)).toBeUndefined()

    const wrongShape = memoryFs({ [externalLinkPath(HOME, "s1")]: JSON.stringify("nope") })
    expect(readExternalLink(HOME, "s1", wrongShape.fs)).toBeUndefined()
  })

  it("does nothing when the fs cannot overwrite", () => {
    const fs: TranscriptFs = { append: () => undefined, read: () => null, mkdirp: () => undefined }
    expect(() =>
      writeExternalLink(HOME, "s1", { backend: "codex", externalSessionId: "x" }, fs)
    ).not.toThrow()
    expect(readExternalLink(HOME, "s1", fs)).toBeUndefined()
  })
})

describe("resumeContinuityNotice", () => {
  const link = (backend: string) =>
    memoryFs({
      [externalLinkPath(HOME, "s1")]: JSON.stringify({ backend, externalSessionId: "acp-7" }),
    }).fs

  it("says nothing on the built-in agent", () => {
    expect(resumeContinuityNotice(HOME, "s1", "builtin", true, link("builtin"))).toBeUndefined()
    expect(resumeContinuityNotice(HOME, "s1", undefined, true, link("codex"))).toBeUndefined()
  })

  it("says nothing when the agent's own session is genuinely resumed", () => {
    expect(resumeContinuityNotice(HOME, "s1", "codex", true, link("codex"))).toBeUndefined()
  })

  it("warns when the agent cannot load a session at all", () => {
    // The transcript comes back; the agent's memory does not.
    expect(resumeContinuityNotice(HOME, "s1", "codex", false, link("codex"))).toContain(
      "does not have it"
    )
  })

  it("warns when nothing was recorded, or it belongs to another agent", () => {
    expect(resumeContinuityNotice(HOME, "s1", "codex", true, memoryFs().fs)).toContain("codex")
    expect(resumeContinuityNotice(HOME, "s1", "codex", true, link("claude-code"))).toContain(
      "not visible"
    )
  })
})

describe("isResumableLink", () => {
  const link = { backend: "codex", externalSessionId: "acp-7" }

  it("accepts a link recorded on the backend now in use", () => {
    expect(isResumableLink(link, "codex")).toBe(true)
  })

  it("refuses another agent's session — no agent can load one", () => {
    expect(isResumableLink(link, "claude-code")).toBe(false)
  })

  it("refuses a missing link or an absent backend", () => {
    expect(isResumableLink(undefined, "codex")).toBe(false)
    expect(isResumableLink(link, undefined)).toBe(false)
  })
})
