import { continueDevSessionSource, parseContinueSession } from "./continue-dev"
import type { SessionScanInput } from "../types"

const SESSION = {
  sessionId: "cont-1",
  title: "Refactor module",
  workspaceDirectory: "/repo",
  history: [
    { message: { role: "user", content: "refactor please" } },
    {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "on it" }],
        toolCalls: [
          { id: "t1", type: "function", function: { name: "edit", arguments: '{"file":"a.ts"}' } },
        ],
      },
    },
    { message: { role: "tool", toolCallId: "t1", content: "edited" } },
  ],
}
const CONTENT = JSON.stringify(SESSION)

describe("parseContinueSession", () => {
  it("maps roles, tool calls, and patches tool output from a tool message", () => {
    const parsed = parseContinueSession(CONTENT, "cont-1.json")
    expect(parsed.originalSessionId).toBe("cont-1")
    expect(parsed.cwd).toBe("/repo")
    expect(parsed.title).toBe("Refactor module")
    // user + assistant (the tool message patches, not appends).
    expect(parsed.messages).toHaveLength(2)
    const asst = parsed.messages[1].parts as Array<Record<string, unknown>>
    expect(asst.map((p) => p.type)).toEqual(["text", "tool-edit"])
    expect(asst[1].input).toEqual({ file: "a.ts" })
    expect(asst[1].state).toBe("output-available")
    expect(asst[1].output).toBe("edited")
  })

  it("returns an empty parse on invalid json", () => {
    expect(parseContinueSession("not json", "x").messages).toEqual([])
  })

  it("maps image-url content parts (string and object forms) and system role", () => {
    const raw = JSON.stringify({
      sessionId: "c2",
      history: [
        { message: { role: "system", content: "you are helpful" } },
        {
          message: {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAA" } },
              { type: "imageUrl", imageUrl: "data:image/png;base64,BBB" },
            ],
          },
        },
      ],
    })
    const parsed = parseContinueSession(raw, "c2.json")
    expect(parsed.messages[0].role).toBe("system")
    const userParts = parsed.messages[1].parts as Array<Record<string, unknown>>
    expect(userParts.map((p) => p.type)).toEqual(["text", "file", "file"])
    expect(userParts[1].url).toBe("data:image/png;base64,AAA")
    expect(userParts[2].url).toBe("data:image/png;base64,BBB")
  })
})

describe("continueDevSessionSource", () => {
  const fs = {
    exists: async () => false,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  }

  it("detects by path hint and content sniff", () => {
    expect(
      continueDevSessionSource.detect([
        { name: "cont-1.json", path: "/home/.continue/sessions/cont-1.json", content: "" },
      ])
    ).toBe("match")
    expect(
      continueDevSessionSource.detect([{ name: "x.json", path: "/tmp/x.json", content: CONTENT }])
    ).toBe("maybe")
    expect(continueDevSessionSource.detect([])).toBe("no")
  })

  function scanFs(files: Record<string, string>) {
    const paths = Object.keys(files)
    return {
      exists: async () => true,
      readDir: async (dir: string) =>
        paths
          .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
          .map((p) => p.slice(dir.length + 1)),
      stat: async (p: string) => ({ size: (files[p] ?? "").length, isFile: p in files }),
      readTextFile: async (p: string) => files[p] ?? "",
    }
  }

  it("auto-scans the sessions dir and parses via the fs", async () => {
    const root = "/home/u/.continue/sessions"
    const input: SessionScanInput = {
      fs: scanFs({ [`${root}/cont-1.json`]: CONTENT, [`${root}/sessions.json`]: "[]" }),
      home: "/home/u",
    }
    const list = await continueDevSessionSource.listSessions(input)
    expect(list).toHaveLength(1)
    const conv = await continueDevSessionSource.parseSession(list[0].ref, input)
    expect(conv.messages).toHaveLength(2)
  })

  it("content-sniffs when there is no path hint", () => {
    expect(
      continueDevSessionSource.detect([
        { name: "a.json", path: "/tmp/a.json", content: CONTENT },
        { name: "b.json", path: "/home/.continue/sessions/b.json", content: "" },
      ])
    ).toBe("maybe")
  })

  it("lists and parses from picked files, skipping the index", async () => {
    const input: SessionScanInput = {
      fs,
      home: "",
      pickedFiles: [
        { name: "cont-1.json", path: "/p/cont-1.json", content: CONTENT },
        { name: "sessions.json", path: "/p/sessions.json", content: "[]" },
      ],
    }
    const list = await continueDevSessionSource.listSessions(input)
    expect(list).toHaveLength(1)
    const conv = await continueDevSessionSource.parseSession(list[0].ref, input)
    expect(conv.session.id).toBe("import:continue-dev:cont-1")
    expect(conv.session.workingDir).toBe("/repo")
  })

  describe("scan roots", () => {
    it("prefers the resolved vendor root over a bare home join", () => {
      // Only the Rust resolver can see where a vendor's tree really lives; this
      // adapter used to derive the path itself from `home`, one of only two that
      // still did (`lib/agent-roots/index.ts` was written to end exactly that).
      const roots = { continueDir: "/relocated/vendor" } as never
      expect(continueDevSessionSource.scanRoots("/home/u", roots)).toEqual([
        "/relocated/vendor/sessions",
      ])
    })

    it("falls back to the home-relative path when the root is unresolved", () => {
      expect(continueDevSessionSource.scanRoots("/home/u", { continueDir: "" } as never)).toEqual([
        "/home/u/.continue/sessions",
      ])
      expect(continueDevSessionSource.scanRoots("", undefined)).toEqual([])
    })
  })
})
