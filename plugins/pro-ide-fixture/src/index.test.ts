import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { normalizeIdeManifest } from "@/lib/plugin/ide/manifest"
import type { PluginManifest } from "@/types/plugin"

import fixture, {
  FIXTURE_CHANGED_URI,
  FIXTURE_MODEL,
  FIXTURE_PING_COMMAND,
  FIXTURE_TESTS,
  chatParticipant,
  customEditor,
  languageModel,
  languageModelTool,
  notebookKernel,
  notebookSerializer,
  ping,
  provideFixtureLenses,
  sourceControl,
  testController,
  webviewView,
} from "./index"

const ROOT = join(__dirname, "..")
const manifest = JSON.parse(readFileSync(join(ROOT, "plugin.json"), "utf8")) as PluginManifest
const doc = (path: string) => ({
  uri: { scheme: "file", path },
  languageId: "typescript",
  version: 1,
})

describe("the manifest the E2E builds a proxy from", () => {
  it("normalizes without an error or a warning", () => {
    expect(normalizeIdeManifest(manifest.id, manifest).warnings).toEqual([])
  })

  it("covers every family the platform claims for a stable release", () => {
    const { manifest: ide } = normalizeIdeManifest(manifest.id, manifest)
    const kinds = new Set(ide.providers.map((provider) => provider.kind))
    // compatibility.mdx: LSP, DAP, MCP, SCM, tests, notebooks,
    // webviews/custom editors, and Chat.
    expect(ide.protocols.lsp).toHaveLength(1)
    expect(ide.protocols.dap).toHaveLength(1)
    expect(ide.protocols.mcp).toHaveLength(1)
    for (const kind of [
      "source-control",
      "test-controller",
      "notebook-serializer",
      "notebook-controller",
      "webview-view",
      "custom-editor",
      "chat-participant",
      "language-model-chat-provider",
      "language-model-tool",
      "code-lens",
      "command",
    ]) {
      expect({ kind, present: kinds.has(kind as never) }).toEqual({ kind, present: true })
    }
  })

  it("pins each protocol server by the digest of the file the proxy will copy", () => {
    for (const executable of manifest.ide!.executables ?? []) {
      const source = executable.source as { path: string; sha256: string }
      const bytes = readFileSync(join(ROOT, source.path))
      expect({ id: executable.id, sha256: source.sha256 }).toEqual({
        id: executable.id,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      })
    }
  })

  it("exports a handler for every provider it declares", () => {
    for (const provider of manifest.ide!.providers ?? []) {
      expect(typeof (fixture as Record<string, unknown>)[provider.handler]).toBe("function")
    }
  })
})

describe("command and code lens", () => {
  it("puts exactly one lens on the first line, titled with the file and clicking back home", () => {
    const lenses = provideFixtureLenses("provide", doc("/repo/lib/deep/file.ts"))
    expect(lenses).toEqual([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        command: {
          command: FIXTURE_PING_COMMAND,
          title: "Cognia fixture: file.ts",
          arguments: [{ path: "/repo/lib/deep/file.ts" }],
        },
      },
    ])
    expect(FIXTURE_PING_COMMAND).toBe("cognia.cognia-pro-ide-fixture.ping")
  })

  it("resolves a lens as given", () => {
    const lens = { range: {}, command: { title: "x" } }
    expect(provideFixtureLenses("resolve", lens as never)).toBe(lens)
  })

  it("ping returns what the click carried, or nothing from the palette", () => {
    expect(ping("execute", { path: "/repo/a.ts" })).toEqual({ ok: true, path: "/repo/a.ts" })
    expect(ping("execute")).toEqual({ ok: true, path: null })
  })
})

describe("source control", () => {
  it("reports one change, a base for quick diff and echoes a commit", () => {
    expect(sourceControl("initialize")).toBeNull()
    expect(sourceControl("status")).toEqual({
      groups: [
        {
          id: "changes",
          label: "Changes",
          resources: [{ uri: FIXTURE_CHANGED_URI, tooltip: "Modified" }],
        },
      ],
    })
    expect(sourceControl("originalResource", FIXTURE_CHANGED_URI)).toBe(
      "cognia-fixture-base:///changed.txt"
    )
    expect(sourceControl("commit", "msg")).toEqual({ committed: "msg" })
    expect(() => sourceControl("push")).toThrow(/unexpected/)
  })
})

describe("tests", () => {
  it("lists three tests at the root and none below", () => {
    expect(testController("resolve", null)).toEqual(FIXTURE_TESTS)
    expect(testController("resolve", { id: "fixture.adds" })).toEqual([])
  })

  it("passes one, fails one and leaves one unreported", () => {
    const run = testController("run") as { results: Array<{ id: string; state: string }> }
    expect(run.results.map((result) => [result.id, result.state])).toEqual([
      ["fixture.adds", "passed"],
      ["fixture.fails", "failed"],
    ])
  })
})

describe("notebooks", () => {
  it("round-trips cells through JSON", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ cells: [{ kind: "code", value: "1 + 1", languageId: "javascript" }] })
    )
    const data = notebookSerializer("deserialize", bytes) as { cells: unknown[] }
    expect(data.cells).toEqual([{ kind: "code", value: "1 + 1", languageId: "javascript" }])
    expect(JSON.parse(notebookSerializer("serialize", data as never) as string)).toEqual(data)
    expect(notebookSerializer("deserialize", new Uint8Array())).toEqual({ cells: [] })
  })

  it("runs a cell by echoing it", () => {
    expect(notebookKernel("execute", { source: "1 + 1" })).toEqual({
      outputs: [{ items: [{ mime: "text/plain", text: "fixture ran: 1 + 1" }] }],
    })
    expect(notebookKernel("interrupt")).toBeNull()
  })
})

describe("webviews", () => {
  it("serves pages that satisfy the managed CSP rule", () => {
    for (const html of [
      (webviewView("resolve") as { html: string }).html,
      (customEditor("resolve", doc("/repo/a.cfxed")) as { html: string }).html,
    ]) {
      expect(html).toMatch(/http-equiv="Content-Security-Policy" content="default-src 'none'"/)
    }
    expect((customEditor("resolve", doc("/repo/a.cfxed")) as { html: string }).html).toContain(
      "a.cfxed"
    )
  })
})

describe("chat", () => {
  it("replies, describes its model, and answers with typed parts", () => {
    expect(chatParticipant("request")).toEqual({
      stream: [{ method: "markdown", arguments: ["Cognia fixture reply"] }],
      result: {},
    })
    expect(languageModel("provideLanguageModelChatInformation")).toEqual([FIXTURE_MODEL])
    expect(
      languageModel("provideLanguageModelChatResponse", FIXTURE_MODEL, [
        { content: [{ value: "abc" }] },
      ])
    ).toEqual({ stream: [{ $type: "LanguageModelTextPart", value: "fixture model: cba" }] })
    expect(languageModel("provideTokenCount", FIXTURE_MODEL, "four")).toBe(4)
    expect(languageModelTool("invoke", { input: { text: "hi" } })).toEqual({
      content: [{ $type: "LanguageModelTextPart", value: "tool: hi" }],
    })
  })
})
