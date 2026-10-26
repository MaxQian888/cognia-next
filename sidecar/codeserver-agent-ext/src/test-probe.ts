/**
 * The real-binary E2E's eyes inside the extension host.
 *
 * The harness drives a real code-server with no UI automation, so it needs a
 * way to ask VS Code what it now shows: the lenses a provider returned, a
 * source control's groups, a test run's outcomes, a notebook's outputs. This
 * module answers through the `testProbe` verb and, while enabled, lets the
 * adapters note what they registered and what VS Code asked them for.
 *
 * Off unless the extension host was started with `COGNIA_CS_TEST_PROBE=1`.
 * Off, the verb does not exist (the dispatcher refuses it as unknown) and
 * nothing is recorded. Never set in production: the probe can run allowlisted
 * VS Code commands, which is exactly what a test needs and nothing else does.
 */

export const TEST_PROBE_ENV = "COGNIA_CS_TEST_PROBE"

export function testProbeEnabled(env: any = globalThis.process?.env ?? {}) {
  return env[TEST_PROBE_ENV] === "1"
}

const WAIT_MS = 20_000

/** What the adapters registered and what VS Code asked them for. */
export function createProbeRecorder(enabled: any = testProbeEnabled()) {
  const tracked = new Map()
  const records: any[] = []
  const waiters = new Set<() => void>()
  return {
    enabled,
    track(kind: any, id: any, value: any) {
      if (!enabled) return
      tracked.set(`${kind}\u0000${id}`, value)
    },
    tracked(kind: any, id: any) {
      return tracked.get(`${kind}\u0000${id}`)
    },
    trackedIds(kind: any) {
      return [...tracked.keys()]
        .filter((key: any) => key.startsWith(`${kind}\u0000`))
        .map((key: any) => key.slice(kind.length + 1))
    },
    record(kind: any, entry: any) {
      if (!enabled) return
      records.push({ kind, ...entry })
      for (const waiter of waiters) waiter()
    },
    records(kind: any) {
      return records.filter((record: any) => record.kind === kind)
    },
    /** Resolve with the first record of `kind` after `since` that `match`es. */
    waitFor(
      kind: any,
      match: any = () => true,
      since: any = records.length,
      timeoutMs: any = WAIT_MS
    ) {
      return new Promise((resolve: any, reject: any) => {
        const check = () => {
          const found = records
            .slice(since)
            .find((record: any) => record.kind === kind && match(record))
          if (!found) return false
          cleanup()
          resolve(found)
          return true
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`TEST_PROBE_TIMEOUT: no ${kind} record`))
        }, timeoutMs)
        const cleanup = () => {
          clearTimeout(timer)
          waiters.delete(check)
        }
        waiters.add(check)
        check()
      })
    },
    get size() {
      return records.length
    },
  }
}

/** The process-wide recorder the adapters write to. */
export const probe = createProbeRecorder()

const ALLOWED_COMMANDS = new Set([
  "vscode.openWith",
  "testing.runAll",
  "notebook.execute",
  "notebook.selectKernel",
  "workbench.action.closeAllEditors",
])

function commandAllowed(command: any) {
  return (
    typeof command === "string" &&
    (command.startsWith("vscode.execute") ||
      command.startsWith("cognia.") ||
      command.endsWith(".focus") ||
      ALLOWED_COMMANDS.has(command))
  )
}

/** `{ $uri }` / `{ $position: [line, character] }` → live VS Code values. */
function reviveArgument(vscode: any, value: any): any {
  if (Array.isArray(value)) return value.map((entry: any): any => reviveArgument(vscode, entry))
  if (!value || typeof value !== "object") return value
  if (typeof value.$uri === "string") return vscode.Uri.parse(value.$uri)
  if (Array.isArray(value.$position)) return new vscode.Position(...value.$position)
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]: any): any => [key, reviveArgument(vscode, entry)])
  )
}

/** A VS Code result as plain JSON the harness can assert on. */
export function plainResult(value: any, seen: any = new WeakSet()): any {
  if (value == null || typeof value !== "object") {
    return typeof value === "function" ? undefined : value
  }
  if (seen.has(value)) return undefined
  seen.add(value)
  if (typeof value.scheme === "string" && typeof value.toString === "function" && "path" in value) {
    return value.toString()
  }
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  if (Array.isArray(value)) return value.map((entry: any): any => plainResult(entry, seen))
  // A MarkdownString: VS Code keeps its fields behind a private delegate, so
  // it has no own keys to copy; its text is what a test asserts on.
  if (
    typeof value.value === "string" &&
    (typeof value.appendMarkdown === "function" || Object.keys(value).includes("isTrusted"))
  ) {
    return value.value
  }
  const result: Record<string, any> = {}
  for (const key of Object.keys(value)) {
    const entry = plainResult(value[key], seen)
    if (entry !== undefined) result[key] = entry
  }
  for (const key of ["start", "end", "line", "character", "range", "title", "command", "label"]) {
    if (!(key in result) && key in value) {
      const entry = plainResult(value[key], seen)
      if (entry !== undefined) result[key] = entry
    }
  }
  return result
}

async function readText(stream: any) {
  let text = ""
  for await (const part of stream) {
    if (typeof part === "string") text += part
    else if (typeof part?.value === "string") text += part.value
  }
  return text
}

/**
 * The `testProbe` verb, or `null` when the probe is off.
 *
 * `params.action` selects what to look at; see the cases below.
 */
/** The most events one `emitEvents` burst may send. */
export const MAX_PROBE_EVENTS = 10_000

/**
 * `emit(name, payload)` sends one uncoalesced editor event over the broker
 * (for `emitEvents`) and reports whether it was written.
 */
export function createTestProbe(vscode: any, recorder: any = probe, { emit }: any = {}) {
  if (!recorder.enabled) return null
  let tracker: any = null
  const debugMessages: any[] = []

  const actions = {
    // Run an allowlisted command and return its result as JSON. `open` shows
    // a file first: the CodeLens command refuses a document with no editor
    // model, and a language server only hears of a file once it is opened.
    async command({ command, args = [], open }: any) {
      if (!commandAllowed(command)) throw new Error(`TEST_PROBE_COMMAND_REFUSED: ${command}`)
      if (typeof open === "string") {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(open))
        await vscode.window.showTextDocument(document)
      }
      return plainResult(
        await vscode.commands.executeCommand(command, ...reviveArgument(vscode, args))
      )
    },
    async scm({ id }: any) {
      const tracked = recorder.tracked("sourceControl", id)
      if (!tracked) throw new Error(`TEST_PROBE_NOT_REGISTERED: source control ${id}`)
      return {
        label: tracked.scm.label,
        count: tracked.scm.count,
        groups: [...tracked.groups.values()].map((group: any) => ({
          id: group.id,
          label: group.label,
          resources: group.resourceStates.map((state: any) => state.resourceUri.toString()),
        })),
      }
    },
    async runTests({ controllerId }: any) {
      const since = recorder.size
      await vscode.commands.executeCommand("testing.runAll")
      return recorder.waitFor("testRun", (run: any) => run.controllerId === controllerId, since)
    },
    async notebook({ path, controllerId, extensionId }: any) {
      const document = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path))
      await vscode.window.showNotebookDocument(document)
      await vscode.commands.executeCommand("notebook.selectKernel", {
        id: controllerId,
        extension: extensionId,
      })
      await vscode.commands.executeCommand("notebook.execute")
      const deadline = Date.now() + WAIT_MS
      const code = () =>
        document.getCells().filter((cell: any) => cell.kind === vscode.NotebookCellKind.Code)
      while (
        code().some(
          (cell: any) => !cell.executionSummary || cell.executionSummary.success === undefined
        )
      ) {
        if (Date.now() > deadline) throw new Error("TEST_PROBE_TIMEOUT: notebook execution")
        await new Promise((resolve: any) => setTimeout(resolve, 100))
      }
      return document.getCells().map((cell: any) => ({
        kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
        source: cell.document.getText(),
        success: cell.executionSummary?.success,
        outputs: cell.outputs.map((output: any) =>
          output.items.map((item: any) => ({
            mime: item.mime,
            text: new TextDecoder().decode(item.data),
          }))
        ),
      }))
    },
    async webviewView({ viewId }: any) {
      const since = recorder.size
      await vscode.commands.executeCommand(`${viewId}.focus`)
      return recorder.waitFor("webview", (record: any) => record.viewType === viewId, since)
    },
    async customEditor({ path, viewType }: any) {
      const since = recorder.size
      await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(path), viewType)
      return recorder.waitFor("customEditor", (record: any) => record.viewType === viewType, since)
    },
    // A burst of numbered lifecycle events, for the zero-loss gate: the
    // harness counts what reaches the app side, in order.
    async emitEvents({ count }: any) {
      if (typeof emit !== "function") throw new Error("TEST_PROBE_UNAVAILABLE: emit")
      const total = Math.min(Math.max(Math.trunc(Number(count) || 0), 0), MAX_PROBE_EVENTS)
      let sent = 0
      for (let seq = 0; seq < total; seq += 1) {
        if (emit("testProbeEvent", { seq })) sent += 1
      }
      return { sent }
    },
    async chatParticipants() {
      return recorder.trackedIds("chatParticipant")
    },
    async languageModel({ vendor, prompt }: any) {
      const [model] = await vscode.lm.selectChatModels({ vendor })
      if (!model) throw new Error(`TEST_PROBE_NOT_REGISTERED: language model ${vendor}`)
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        new vscode.CancellationTokenSource().token
      )
      return { id: model.id, text: await readText(response.text) }
    },
    async tool({ name, input }: any) {
      const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined })
      return result.content.map((part: any) => part.value ?? plainResult(part))
    },
    async debug({ configuration }: any) {
      if (!tracker) {
        tracker = vscode.debug.registerDebugAdapterTrackerFactory("*", {
          createDebugAdapterTracker: () => ({
            onDidSendMessage: (message: any) => debugMessages.push(message),
          }),
        })
      }
      debugMessages.length = 0
      const ended = new Promise((resolve: any) => {
        const listener = vscode.debug.onDidTerminateDebugSession(() => {
          listener.dispose()
          resolve()
        })
      })
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (!(await vscode.debug.startDebugging(folder, configuration))) {
        throw new Error("TEST_PROBE_DEBUG_NOT_STARTED")
      }
      await Promise.race([
        ended,
        new Promise((_: any, reject: any) =>
          setTimeout(() => reject(new Error("TEST_PROBE_TIMEOUT: debug session")), WAIT_MS)
        ),
      ])
      return debugMessages
        .filter((message: any) => message.type === "event" && message.event === "output")
        .map((message: any) => message.body?.output)
    },
    async mcp({ providerId }: any) {
      const provider = recorder.tracked("mcpProvider", providerId)
      if (!provider) throw new Error(`TEST_PROBE_NOT_REGISTERED: MCP provider ${providerId}`)
      const token = new vscode.CancellationTokenSource().token
      const [definition] = (await provider.provideMcpServerDefinitions(token)) ?? []
      const resolved = provider.resolveMcpServerDefinition
        ? await provider.resolveMcpServerDefinition(definition, token)
        : definition
      const call = async (id: any, method: any, params: any) => {
        const response = await fetch(resolved.uri.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(resolved.headers ?? {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        })
        const text = await response.text()
        const json = text.startsWith("{") ? text : text.split("data: ").pop()
        return JSON.parse(json!)
      }
      await call(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cognia-test-probe", version: "1.0.0" },
      })
      const listed = await call(2, "tools/list", {})
      return (listed.result?.tools ?? []).map((tool: any) => tool.name)
    },
  }

  return async function testProbe(params: any) {
    const action = Object.hasOwn(actions, params?.action ?? "")
      ? actions[params.action as keyof typeof actions]
      : null
    if (!action) throw new Error(`TEST_PROBE_UNKNOWN_ACTION: ${params?.action}`)
    return action(params)
  }
}
