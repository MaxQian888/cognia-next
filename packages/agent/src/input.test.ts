/**
 * @jest-environment node
 */
import fs from "node:fs"
import path from "node:path"

import { extractFileRefs } from "@/cli/src/agent/attachments/classify"

import { lowerAgentInput, safeAttachmentName, type AgentAttachment } from "./input"

/** Records what was written without touching disk. */
function spy() {
  const writes = new Map<string, Buffer>()
  const removed: string[] = []
  return {
    writes,
    removed,
    options: {
      tempDir: "/tmp/spill",
      mkdtemp: (prefix: string) => `${prefix}fixed`,
      writeFile: (target: string, data: Buffer) => void writes.set(target, data),
      rm: (target: string) => void removed.push(target),
    },
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")

function ok(result: ReturnType<typeof lowerAgentInput>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`)
  return result.value
}

describe("lowerAgentInput — text", () => {
  it("passes a bare string through untouched, @refs and all", () => {
    const value = ok(lowerAgentInput("summarize @notes.md please"))
    expect(value.prompt).toBe("summarize @notes.md please")
  })

  it("treats { text } with no attachments as equivalent to the bare string", () => {
    expect(ok(lowerAgentInput({ text: "hello" })).prompt).toBe("hello")
  })

  it("tolerates an input with neither text nor attachments", () => {
    expect(ok(lowerAgentInput({})).prompt).toBe("")
  })

  it("always returns a callable cleanup, so callers need no attachment check", () => {
    // Every caller runs `cleanup()` in a finally block. If the no-attachment
    // paths returned undefined instead of a no-op, every text-only prompt would
    // throw on the way out.
    expect(() => ok(lowerAgentInput("plain")).cleanup()).not.toThrow()
    expect(() => ok(lowerAgentInput({ text: "plain" })).cleanup()).not.toThrow()
    expect(() => ok(lowerAgentInput({ attachments: [] })).cleanup()).not.toThrow()
  })
})

describe("lowerAgentInput — path attachments", () => {
  it("lowers a path to a quoted @ref the existing extractor resolves", () => {
    const value = ok(
      lowerAgentInput({ text: "review this", attachments: [{ kind: "path", path: "/a/b.png" }] })
    )
    expect(value.prompt).toContain('@"/a/b.png"')
    // The contract that matters: the CLI's own extractor must find it.
    expect(extractFileRefs(value.prompt)).toEqual(["/a/b.png"])
  })

  it("survives a path containing spaces, which the bare @ref form cannot express", () => {
    const value = ok(
      lowerAgentInput({ attachments: [{ kind: "path", path: "/a/Screen Shot 1.png" }] })
    )
    expect(extractFileRefs(value.prompt)).toEqual(["/a/Screen Shot 1.png"])
  })

  it("keeps the instruction first and the attachments after it", () => {
    const value = ok(
      lowerAgentInput({
        text: "compare these",
        attachments: [
          { kind: "path", path: "a.png" },
          { kind: "path", path: "b.png" },
        ],
      })
    )
    expect(value.prompt.indexOf("compare these")).toBeLessThan(value.prompt.indexOf("a.png"))
    expect(extractFileRefs(value.prompt)).toEqual(["a.png", "b.png"])
  })

  it("rejects an empty path instead of emitting a ref to nothing", () => {
    const result = lowerAgentInput({ attachments: [{ kind: "path", path: "   " }] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("config_error")
  })

  it("rejects a file the attachment pipeline has no handler for", () => {
    // Left to the runtime this would land in `buildAttachmentContent`'s
    // `skipped` list — indistinguishable, to the caller, from being read.
    const result = lowerAgentInput({ attachments: [{ kind: "path", path: "/a/archive.zip" }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain("archive.zip")
    expect(result.error.message).toContain("no recognized file type")
  })
})

describe("lowerAgentInput — base64 attachments", () => {
  it("spills bytes to a file and references it", () => {
    const s = spy()
    const value = ok(
      lowerAgentInput(
        { attachments: [{ kind: "base64", data: PNG, mediaType: "image/png" }] },
        s.options
      )
    )
    const written = [...s.writes.keys()]
    expect(written).toHaveLength(1)
    expect(extractFileRefs(value.prompt)).toEqual(written)
    expect(s.writes.get(written[0]!)?.toString("base64")).toBe(PNG)
  })

  it("gives the spill the extension implied by its media type", () => {
    const s = spy()
    ok(
      lowerAgentInput(
        { attachments: [{ kind: "base64", data: PNG, mediaType: "image/png" }] },
        s.options
      )
    )
    expect([...s.writes.keys()][0]).toMatch(/\.png$/)
  })

  it("does not double-append an extension the filename already has", () => {
    const s = spy()
    ok(
      lowerAgentInput(
        {
          attachments: [
            { kind: "base64", data: PNG, mediaType: "image/png", filename: "shot.png" },
          ],
        },
        s.options
      )
    )
    expect([...s.writes.keys()][0]).toMatch(/[\\/]shot\.png$/)
  })

  it("rejects a media type the agent cannot read, before writing anything", () => {
    const s = spy()
    const result = lowerAgentInput(
      { attachments: [{ kind: "base64", data: PNG, mediaType: "application/x-tar" }] },
      s.options
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detail).toMatchObject({ mediaType: "application/x-tar" })
    expect(s.writes.size).toBe(0)
  })

  it("rejects data that is not base64 rather than writing a truncated file", () => {
    const s = spy()
    const result = lowerAgentInput(
      { attachments: [{ kind: "base64", data: "!!!!!!", mediaType: "image/png" }] },
      s.options
    )
    expect(result.ok).toBe(false)
    expect(s.writes.size).toBe(0)
  })

  it("rejects empty data", () => {
    const result = lowerAgentInput(
      { attachments: [{ kind: "base64", data: "", mediaType: "image/png" }] },
      spy().options
    )
    expect(result.ok).toBe(false)
  })

  it("removes the spill when cleanup is called", () => {
    const s = spy()
    const value = ok(
      lowerAgentInput(
        { attachments: [{ kind: "base64", data: PNG, mediaType: "image/png" }] },
        s.options
      )
    )
    value.cleanup()
    expect(s.removed).toContain([...s.writes.keys()][0])
  })

  it("cleans up already-written spills when a LATER attachment is rejected", () => {
    const s = spy()
    const attachments: AgentAttachment[] = [
      { kind: "base64", data: PNG, mediaType: "image/png" },
      { kind: "path", path: "" },
    ]
    const result = lowerAgentInput({ attachments }, s.options)
    expect(result.ok).toBe(false)
    // A rejected input must not leave the caller's bytes lying on disk.
    expect(s.removed).toContain([...s.writes.keys()][0])
  })

  it("reports a write failure instead of referencing a file that is not there", () => {
    const result = lowerAgentInput(
      { attachments: [{ kind: "base64", data: PNG, mediaType: "image/png" }] },
      {
        ...spy().options,
        writeFile: () => {
          throw new Error("EACCES")
        },
      }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain("EACCES")
  })

  it("survives a cleanup whose removal throws", () => {
    const value = ok(
      lowerAgentInput(
        { attachments: [{ kind: "base64", data: PNG, mediaType: "image/png" }] },
        {
          ...spy().options,
          rm: () => {
            throw new Error("EBUSY")
          },
        }
      )
    )
    expect(() => value.cleanup()).not.toThrow()
  })

  it("makes cleanup idempotent", () => {
    const s = spy()
    const value = ok(
      lowerAgentInput(
        { attachments: [{ kind: "base64", data: PNG, mediaType: "image/png" }] },
        s.options
      )
    )
    value.cleanup()
    const afterFirst = s.removed.length
    value.cleanup()
    expect(s.removed.length).toBe(afterFirst)
  })

  it("mints its own spill directory when none is supplied", () => {
    const made: string[] = []
    const value = ok(
      lowerAgentInput(
        { attachments: [{ kind: "base64", data: PNG, mediaType: "image/png" }] },
        {
          mkdtemp: (prefix) => {
            made.push(prefix)
            return "/tmp/minted"
          },
          writeFile: () => {},
          rm: () => {},
        }
      )
    )
    expect(made).toHaveLength(1)
    expect(extractFileRefs(value.prompt)[0]).toContain("/tmp/minted")
  })
})

describe("safeAttachmentName", () => {
  it("keeps an ordinary name", () => {
    expect(safeAttachmentName("report.pdf", 0)).toBe("report.pdf")
  })

  it("strips directory components so a name cannot climb out of the spill dir", () => {
    // The name reaches path.join with a directory we control, so the bytes
    // would be WRITTEN wherever this pointed.
    expect(safeAttachmentName("../../.ssh/authorized_keys", 0)).toBe("authorized_keys")
    expect(safeAttachmentName("/etc/passwd", 0)).toBe("passwd")
  })

  it("refuses to produce a dotfile", () => {
    expect(safeAttachmentName("...hidden", 0)).toBe("hidden")
  })

  it("replaces characters that would break the @ref or the filesystem", () => {
    expect(safeAttachmentName('we"ird name.png', 0)).toBe("we_ird_name.png")
  })

  it("falls back to an indexed name when nothing usable survives", () => {
    expect(safeAttachmentName("///", 3)).toBe("attachment-3")
    expect(safeAttachmentName(undefined, 1)).toBe("attachment-1")
  })

  it("bounds the length", () => {
    expect(safeAttachmentName("a".repeat(500), 0)).toHaveLength(128)
  })
})

// Every test above injects the fs effects. These exercise the DEFAULTS — the
// real `mkdtempSync`/`writeFileSync`/`rmSync` path every actual caller takes.
describe("lowerAgentInput — real filesystem", () => {
  it("spills to a real temp file and removes it on cleanup", () => {
    const value = ok(
      lowerAgentInput({
        text: "look",
        attachments: [{ kind: "base64", data: PNG, mediaType: "image/png", filename: "shot.png" }],
      })
    )
    const [spilled] = extractFileRefs(value.prompt)
    expect(spilled).toBeDefined()
    expect(fs.existsSync(spilled!)).toBe(true)
    expect(fs.readFileSync(spilled!).toString("base64")).toBe(PNG)

    value.cleanup()
    expect(fs.existsSync(spilled!)).toBe(false)
    // The minted directory goes too — a per-run temp dir must not accumulate.
    expect(fs.existsSync(path.dirname(spilled!))).toBe(false)
  })
})
