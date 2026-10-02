/**
 * Pro IDE contribution fixture (ADR-0088).
 *
 * The managed Pro IDE pathway — manifest.ide → normalizeIdeManifest → signed
 * proxy VSIX → broker handshake → provider round-trip — is roughly 150k lines
 * of Rust, TypeScript and JavaScript whose layers each have unit tests. This
 * plugin is what the real-binary E2E (`lib/plugin/ide/real-code-server.e2e.test.ts`)
 * drives through a real code-server to prove the whole works, one family at a
 * time: every family the platform claims for a stable release has one trivial
 * provider here, and a family that does not round-trip fails the E2E.
 *
 * Every handler is called as `handler(operation, ...args)`: the broker runtime
 * passes the adapter's operation name first, then the serialized VS Code
 * arguments. Answers are deterministic and name what they were asked about, so
 * a value coming back proves the request genuinely crossed the broker.
 *
 * It is a fixture, not a feature: it ships no product surface and can change
 * freely when the pathway changes, which is what a regression harness needs.
 * The protocol families (language server, debug adapter, MCP server) are the
 * three self-contained scripts under `servers/`.
 */

/** A plugin-local id as VS Code knows it: the proxy compiler namespaces them. */
export const FIXTURE_NAMESPACE = "cognia.cognia-pro-ide-fixture"
export const FIXTURE_PING_COMMAND = `${FIXTURE_NAMESPACE}.ping`

/** How the broker serializes a `vscode.Uri` (its `toJSON` form). */
interface SerializedUri {
  scheme: string
  path: string
}

/** How the broker serializes a `vscode.TextDocument`. */
interface SerializedDocument {
  uri: SerializedUri
  languageId: string
  version: number
}

const basename = (path: string) => path.split(/[/\\]/).pop() ?? path

/** The `command` provider: the lens click lands here. */
export function ping(
  _operation: string,
  argument?: { path?: string }
): { ok: true; path: string | null } {
  return { ok: true, path: argument?.path ?? null }
}

/**
 * One lens on the first line of every file, titled with the file's name.
 *
 * Always exactly one: a fixture that produced lenses conditionally would make
 * a broken round trip and an empty result look identical.
 */
export function provideFixtureLenses(operation: string, document: SerializedDocument) {
  if (operation === "resolve") return document
  const path = document?.uri?.path ?? ""
  return [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      command: {
        command: FIXTURE_PING_COMMAND,
        title: `Cognia fixture: ${basename(path)}`,
        arguments: [{ path }],
      },
    },
  ]
}

export const FIXTURE_CHANGED_URI = "file:///cognia-fixture/changed.txt"

/** Source control with one changed file and a commit that echoes its message. */
export function sourceControl(operation: string, ...args: unknown[]) {
  switch (operation) {
    case "initialize":
      return null
    case "status":
      return {
        groups: [
          {
            id: "changes",
            label: "Changes",
            resources: [{ uri: FIXTURE_CHANGED_URI, tooltip: "Modified" }],
          },
        ],
      }
    case "originalResource":
      return "cognia-fixture-base:///changed.txt"
    case "commit":
      return { committed: String(args[0] ?? "") }
    default:
      throw new Error(`unexpected source-control operation ${operation}`)
  }
}

export const FIXTURE_TESTS = [
  { id: "fixture.adds", label: "adds" },
  { id: "fixture.fails", label: "fails" },
  { id: "fixture.unreported", label: "unreported" },
]

/**
 * Three tests: one passes, one fails, one the run says nothing about (which the
 * adapter must still settle, as skipped).
 */
export function testController(operation: string, item?: { id?: string } | null) {
  if (operation === "resolve") return item ? [] : FIXTURE_TESTS
  if (operation === "run") {
    return {
      results: [
        { id: "fixture.adds", state: "passed", durationMs: 1 },
        { id: "fixture.fails", state: "failed", message: "fixture failure" },
      ],
      output: "ran 2 fixture tests\n",
    }
  }
  throw new Error(`unexpected test-controller operation ${operation}`)
}

interface NotebookCellJson {
  kind: "code" | "markup"
  value: string
  languageId?: string
}

/** `.cfxnb` files are JSON: `{ cells: [{ kind, value, languageId }] }`. */
export function notebookSerializer(
  operation: string,
  input: Uint8Array | { cells?: NotebookCellJson[] }
) {
  if (operation === "deserialize") {
    const text = input instanceof Uint8Array ? new TextDecoder().decode(input) : ""
    const parsed = text.trim() ? (JSON.parse(text) as { cells?: NotebookCellJson[] }) : {}
    return { cells: parsed.cells ?? [] }
  }
  if (operation === "serialize") {
    const cells = (input as { cells?: NotebookCellJson[] }).cells ?? []
    return JSON.stringify({
      cells: cells.map(({ kind, value, languageId }) => ({ kind, value, languageId })),
    })
  }
  throw new Error(`unexpected notebook-serializer operation ${operation}`)
}

/** A kernel that "runs" a cell by echoing its source as plain text. */
export function notebookKernel(operation: string, cell?: { source?: string }) {
  if (operation === "interrupt") return null
  if (operation === "execute") {
    return {
      outputs: [{ items: [{ mime: "text/plain", text: `fixture ran: ${cell?.source ?? ""}` }] }],
    }
  }
  throw new Error(`unexpected notebook-controller operation ${operation}`)
}

const page = (body: string) =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body>${body}</body></html>`

export function webviewView(operation: string) {
  if (operation === "resolve") return { html: page("<p>Cognia fixture view</p>") }
  return null
}

export function customEditor(operation: string, document?: SerializedDocument) {
  if (operation === "resolve") {
    return { html: page(`<p>Cognia fixture editor: ${basename(document?.uri?.path ?? "")}</p>`) }
  }
  return null
}

export function chatParticipant(operation: string) {
  if (operation !== "request") throw new Error(`unexpected chat operation ${operation}`)
  return { stream: [{ method: "markdown", arguments: ["Cognia fixture reply"] }], result: {} }
}

export const FIXTURE_MODEL = {
  id: "fixture-model",
  name: "Cognia Fixture Model",
  family: "fixture",
  version: "1.0.0",
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  capabilities: {},
}

/** A model that answers every request with the last message's text, reversed. */
export function languageModel(operation: string, ...args: unknown[]) {
  switch (operation) {
    case "provideLanguageModelChatInformation":
      return [FIXTURE_MODEL]
    case "provideLanguageModelChatResponse": {
      const messages = (args[1] ?? []) as Array<{ content?: Array<{ value?: string }> }>
      const last =
        messages
          .at(-1)
          ?.content?.map((part) => part.value ?? "")
          .join("") ?? ""
      return {
        stream: [
          {
            $type: "LanguageModelTextPart",
            value: `fixture model: ${[...last].reverse().join("")}`,
          },
        ],
      }
    }
    case "provideTokenCount":
      return String(args[1] ?? "").length
    default:
      throw new Error(`unexpected language model operation ${operation}`)
  }
}

export function languageModelTool(operation: string, options?: { input?: { text?: string } }) {
  if (operation === "prepare") return null
  if (operation === "invoke") {
    return { content: [{ $type: "LanguageModelTextPart", value: `tool: ${options?.input?.text}` }] }
  }
  throw new Error(`unexpected tool operation ${operation}`)
}

/** The plugin runtime resolves provider handlers off this default export. */
const fixture = {
  ping,
  provideFixtureLenses,
  sourceControl,
  testController,
  notebookSerializer,
  notebookKernel,
  webviewView,
  customEditor,
  chatParticipant,
  languageModel,
  languageModelTool,
}
export default fixture
