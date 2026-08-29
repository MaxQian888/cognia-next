import { aiderSessionSource, parseAiderHistory } from "./aider"
import type { SessionScanInput } from "../types"

const MD = `# aider chat started at 2025-01-01 12:00:00

> Aider v0.1 note
#### fix the bug
#### please

I'll fix it now.

Here is the change.

> Tokens: 100 sent
`

describe("parseAiderHistory", () => {
  it("splits #### user turns from assistant prose, skipping > notes", () => {
    const parsed = parseAiderHistory(MD, "/repo/.aider.chat.history.md")
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0].role).toBe("user")
    expect((parsed.messages[0].parts[0] as Record<string, unknown>).text).toBe(
      "fix the bug\nplease"
    )
    expect(parsed.messages[1].role).toBe("assistant")
    expect((parsed.messages[1].parts[0] as Record<string, unknown>).text).toBe(
      "I'll fix it now.\n\nHere is the change."
    )
    expect(parsed.title).toBe("fix the bug please")
  })

  it("handles an empty file", () => {
    expect(parseAiderHistory("", "x.md").messages).toEqual([])
  })
})

describe("aiderSessionSource", () => {
  const fs = {
    exists: async () => false,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  }

  it("has no scan root (picker only) and detects by filename + content", () => {
    expect(aiderSessionSource.scanRoots("/home")).toEqual([])
    expect(
      aiderSessionSource.detect([
        { name: ".aider.chat.history.md", path: "/repo/.aider.chat.history.md", content: "" },
      ])
    ).toBe("match")
    expect(aiderSessionSource.detect([{ name: "x.md", path: "/x.md", content: MD }])).toBe("maybe")
    expect(aiderSessionSource.detect([])).toBe("no")
  })

  it("parses via the fs when not in picker mode", async () => {
    const input: SessionScanInput = {
      fs: { ...fs, readTextFile: async () => MD },
      home: "",
    }
    const conv = await aiderSessionSource.parseSession(
      {
        sourceId: "aider",
        originalSessionId: "/repo/.aider.chat.history.md",
        locator: "/repo/.aider.chat.history.md",
      },
      input
    )
    expect(conv.messages).toHaveLength(2)
  })

  it("lists and parses a picked file", async () => {
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [
        { name: ".aider.chat.history.md", path: "/repo/.aider.chat.history.md", content: MD },
      ],
    }
    const list = await aiderSessionSource.listSessions(input)
    expect(list).toHaveLength(1)
    const conv = await aiderSessionSource.parseSession(list[0].ref, input)
    expect(conv.session.id).toContain("import:aider:")
    expect(conv.messages).toHaveLength(2)
    expect(aiderSessionSource).toMatchObject({
      verifiedVersion: "0.86.2",
      verifiedAt: "2026-08-29",
      parseGraph: expect.any(Function),
    })
    const graph = await aiderSessionSource.parseGraph!(list[0].ref, input)
    expect(graph.nodes[0].loss).toMatchObject({
      fidelity: "contextual",
      losses: expect.arrayContaining([expect.objectContaining({ path: "markdown" })]),
    })
  })
})
