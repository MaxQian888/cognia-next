import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { registerManagedProviders } from "../src/provider-adapters.ts"

// The SCM, testing and notebook adapters used to register a shell and forward
// one call: no resource groups, no reported test outcomes, no cell outputs.
// These pin what each now does with the plugin's answers.

const descriptor = (providers: any) => ({
  pluginId: "acme.tools",
  pluginVersion: "1.0.0",
  manifestHash: "sha256:m",
  catalogHash: "sha256:c",
  platformVersion: "1.0.0",
  providers,
})

class Uri {
  declare scheme: string
  declare path: string
  constructor(parts: any) {
    Object.assign(this, parts)
  }
  static parse(value: any) {
    const [scheme, rest] = value.split("://")
    return new Uri({ scheme, authority: "", path: rest ?? "", query: "", fragment: "" })
  }
  static from(parts: any) {
    return new Uri(parts)
  }
  toString() {
    return `${this.scheme}://${this.path}`
  }
}

function emitter() {
  const listeners: any[] = []
  const event = (listener: any) => {
    listeners.push(listener)
    return { dispose() {} }
  }
  return { event, fire: (value: any) => listeners.forEach((listener: any) => listener(value)) }
}

function fakeVscode() {
  const calls: any = {
    scm: null,
    commands: new Map(),
    watchers: [] as any[],
    runs: [] as any[],
    executions: [] as any[],
  }
  const vscode: any = {
    calls,
    Uri,
    RelativePattern: class {
      constructor(base: any, pattern: any) {
        Object.assign(this, { base, pattern })
      }
    },
    Disposable: {
      from: (...items: any[]) => ({ dispose: () => items.forEach((item: any) => item.dispose()) }),
    },
    commands: {
      registerCommand(id: any, handler: any) {
        calls.commands.set(id, handler)
        return { dispose: () => calls.commands.delete(id) }
      },
    },
    workspace: {
      createFileSystemWatcher(pattern: any) {
        const change = emitter()
        const watcher = {
          pattern,
          onDidChange: change.event,
          onDidCreate: change.event,
          onDidDelete: change.event,
          fireChange: change.fire,
          dispose() {},
        }
        calls.watchers.push(watcher)
        return watcher
      },
      registerNotebookSerializer(type: any, serializer: any) {
        calls.serializer = { type, serializer }
        return { dispose() {} }
      },
    },
    scm: {
      createSourceControl(id: any, label: any, rootUri: any) {
        const groups: any[] = []
        calls.scm = {
          id,
          label,
          rootUri,
          groups,
          inputBox: { value: "", placeholder: "" },
          count: undefined,
          createResourceGroup(groupId: any, groupLabel: any) {
            const group = {
              id: groupId,
              label: groupLabel,
              resourceStates: [] as any[],
              disposed: false,
              dispose() {
                this.disposed = true
              },
            }
            groups.push(group)
            return group
          },
          dispose() {},
        }
        return calls.scm
      },
    },
    TestRunProfileKind: { Run: 1, Debug: 2 },
    TestTag: class {
      declare id: any

      constructor(id: any) {
        this.id = id
      }
    },
    TestMessage: class {
      declare message: any

      constructor(message: any) {
        this.message = message
      }
    },
    tests: {
      createTestController(id: any, label: any) {
        const items = new Map()
        const collection = {
          replace(next: any) {
            items.clear()
            for (const item of next) items.set(item.id, item)
          },
          forEach: (fn: any) => items.forEach((item: any) => fn(item)),
        }
        const controller = {
          id,
          label,
          items: collection,
          profiles: [] as any[],
          createTestItem: (itemId: any, itemLabel: any) => ({
            id: itemId,
            label: itemLabel,
            children: { forEach() {}, replace() {} },
          }),
          createRunProfile(profileLabel: any, kind: any, handler: any) {
            controller.profiles.push({ label: profileLabel, kind, handler })
          },
          createTestRun(request: any, name: any) {
            const run: any = { request, name, events: [] as any[], output: "" }
            for (const method of [
              "enqueued",
              "started",
              "passed",
              "failed",
              "errored",
              "skipped",
            ]) {
              run[method] = (item: any, ...rest: any[]) =>
                run.events.push([method, item.id, ...rest])
            }
            run.appendOutput = (text: any) => (run.output += text)
            run.end = () => run.events.push(["end"])
            calls.runs.push(run)
            return run
          },
          dispose() {},
        }
        calls.controller = controller
        return controller
      },
    },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookCellData: class {
      constructor(kind: any, value: any, languageId: any) {
        Object.assign(this, { kind, value, languageId })
      }
    },
    NotebookData: class {
      declare cells: any

      constructor(cells: any) {
        this.cells = cells
      }
    },
    NotebookCellOutputItem: Object.assign(
      class {
        constructor(data: any, mime: any) {
          Object.assign(this, { data, mime })
        }
      },
      {
        text: (text: any, mime: any) => ({ mime, data: new TextEncoder().encode(text) }),
        error: (error: any) => ({
          mime: "application/vnd.code.notebook.error",
          error: String(error),
        }),
      }
    ),
    NotebookCellOutput: class {
      constructor(items: any, metadata: any) {
        Object.assign(this, { items, metadata })
      }
    },
    notebooks: {
      createNotebookController(id: any, type: any, label: any) {
        const controller = {
          id,
          type,
          label,
          createNotebookCellExecution(cell: any): any {
            const execution: any = {
              cell,
              token: { isCancellationRequested: false },
              outputs: null,
              start: (at: any) => (execution.startedAt = at),
              replaceOutput: async (outputs: any) => (execution.outputs = outputs),
              end: (success: any) => (execution.success = success),
            }
            calls.executions.push(execution)
            return execution
          },
          dispose() {},
        }
        calls.notebookController = controller
        return controller
      },
    },
  }
  return vscode
}

function broker(answers: any) {
  const calls: any[] = []
  let onEvent: any = null
  return {
    calls,
    emit: (message: any) => onEvent?.(message),
    invoke: async (provider: any, operation: any, args: any) => {
      calls.push({ operation, args })
      const answer = answers[operation]
      return typeof answer === "function" ? answer(...args) : answer
    },
    onEvent(listener: any) {
      onEvent = listener
      return { dispose: () => (onEvent = null) }
    },
    // Binary arguments travel as content handles, as through the real broker.
    createContent: async (_provider: any, bytes: any) => ({
      $type: "ContentHandle",
      size: bytes.length,
    }),
  }
}

/** Run events with any TestMessage reduced to its text, for comparison. */
const plain = (events: any) =>
  events.map((event: any) =>
    event.map((part: any) => (part?.message !== undefined ? part.message : part))
  )

describe("source control", () => {
  const provider = {
    id: "cognia.acme.tools.scm",
    kind: "source-control",
    handler: "scm",
    metadata: { label: "Acme VCS", rootUri: "file:///work", inputPlaceholder: "Message" },
  }

  test("shows the plugin's groups and resources, and keeps them current", async () => {
    const vscode: any = fakeVscode()
    let state: any = {
      groups: [
        {
          id: "changes",
          label: "Changes",
          resources: [{ uri: "file:///work/a.ts", tooltip: "Modified" }],
        },
        { id: "staged", label: "Staged", resources: [] as any[] },
      ],
    }
    const b = broker({ initialize: null, status: () => state })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const scm = vscode.calls.scm
    assert.equal(scm!.label, "Acme VCS")
    assert.equal(scm!.rootUri.toString(), "file:///work")
    assert.equal(scm!.inputBox.placeholder, "Message")
    assert.deepEqual(
      b.calls.map((call: any) => call.operation),
      ["initialize", "status"]
    )
    assert.equal(scm!.groups[0].resourceStates[0].resourceUri.toString(), "file:///work/a.ts")
    assert.equal(scm!.groups[0].resourceStates[0].decorations.tooltip, "Modified")
    assert.equal(scm!.count, 1)

    // A plugin-sent change drops a group that is gone and recounts.
    state = { groups: [{ id: "changes", label: "Changes", resources: [] as any[] }], count: 0 }
    b.emit({ providerId: provider.id, event: "changed" })
    await new Promise<any>((resolve: any) => setTimeout(resolve, 0))
    assert.equal(scm!.groups[1].disposed, true)
    assert.equal(scm!.count, 0)
  })

  test("commits the input box, clears it and re-reads status", async () => {
    const vscode: any = fakeVscode()
    const b = broker({ initialize: null, status: { groups: [] as any[] }, commit: null })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const scm = vscode.calls.scm
    assert.equal(scm!.acceptInputCommand.command, `${provider.id}.acceptInput`)
    scm!.inputBox.value = "fix: it"
    await vscode.calls.commands.get(`${provider.id}.acceptInput`)()
    assert.deepEqual(
      b.calls.slice(-2).map((call: any) => [call.operation, call.args]),
      [
        ["commit", ["fix: it"]],
        ["status", []],
      ]
    )
    assert.equal(scm!.inputBox.value, "")
  })

  test("serves quick diff from the plugin's original resource", async () => {
    const vscode: any = fakeVscode()
    const b = broker({
      initialize: null,
      status: { groups: [] as any[] },
      originalResource: "acme://base/a.ts",
    })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const original = await vscode.calls.scm!.quickDiffProvider.provideOriginalResource(
      Uri.parse("file:///work/a.ts")
    )
    assert.equal(original.toString(), "acme://base/a.ts")
  })
})

describe("test controller", () => {
  const provider = {
    id: "cognia.acme.tools.tests",
    kind: "test-controller",
    handler: "tests",
    metadata: {
      label: "Acme tests",
      runProfiles: [{ label: "Run", kind: "Run", isDefault: true }],
    },
  }

  async function setUp(answers: any) {
    const vscode: any = fakeVscode()
    const b = broker(answers)
    await registerManagedProviders(vscode, descriptor([provider]), b)
    // Registration already resolved the root; the run sees those items.
    assert.equal(b.calls[0].operation, "resolve")
    return { vscode, b }
  }

  test("reports every outcome and settles what the plugin did not mention", async () => {
    const { vscode, b } = await setUp({
      resolve: [
        { id: "t1", label: "adds" },
        { id: "t2", label: "subtracts" },
        { id: "t3", label: "divides" },
      ],
      run: {
        results: [
          { id: "t1", state: "passed", durationMs: 3 },
          { id: "t2", state: "failed", message: "expected 1, got 2" },
        ],
        output: "ran 2\n",
      },
    })
    await vscode.calls.controller.profiles[0].handler(
      { include: undefined, exclude: [] as any[] },
      {}
    )
    const run = vscode.calls.runs[0]
    const outcomes = plain(
      run.events.filter(([kind]: any) => !["enqueued", "started"].includes(kind))
    )
    assert.deepEqual(outcomes, [
      ["passed", "t1", 3],
      ["failed", "t2", "expected 1, got 2", undefined],
      ["skipped", "t3"],
      ["end"],
    ])
    assert.equal(run.output, "ran 2\r\n")
    assert.deepEqual(b.calls.at(-1).args[0], {
      profile: "Run",
      include: undefined,
      exclude: [] as any[],
    })
  })

  test("a failed run errors every test it did not settle and still ends", async () => {
    const { vscode } = await setUp({
      resolve: [{ id: "t1", label: "adds" }],
      run: () => {
        throw new Error("runner crashed")
      },
    })
    await vscode.calls.controller.profiles[0].handler(
      { include: undefined, exclude: [] as any[] },
      {}
    )
    const run = vscode.calls.runs[0]
    assert.deepEqual(plain(run.events.slice(-2)), [["errored", "t1", "runner crashed"], ["end"]])
  })
})

describe("notebooks", () => {
  test("deserializes into NotebookData and serializes text back to bytes", async () => {
    const vscode: any = fakeVscode()
    const provider = {
      id: "cognia.acme.tools.nb",
      kind: "notebook-serializer",
      handler: "notebook",
      metadata: { notebookType: "cognia.acme.tools.acme-notebook" },
    }
    const b = broker({
      deserialize: {
        cells: [
          { kind: "markup", value: "# Title" },
          { kind: "code", value: "1 + 1", languageId: "javascript" },
        ],
        metadata: { version: 1 },
      },
      serialize: (summary: any) => JSON.stringify(summary.cells.map((cell: any) => cell.value)),
    })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const { serializer } = vscode.calls.serializer
    const data = await serializer.deserializeNotebook(new Uint8Array(), {})
    assert.deepEqual(
      data.cells.map((cell: any) => [cell.kind, cell.value, cell.languageId]),
      [
        [1, "# Title", "markdown"],
        [2, "1 + 1", "javascript"],
      ]
    )
    assert.deepEqual(data.metadata, { version: 1 })
    const bytes = await serializer.serializeNotebook(data, {})
    assert.equal(new TextDecoder().decode(bytes), '["# Title","1 + 1"]')
  })

  test("executes cells one by one, writing outputs and an error output on failure", async () => {
    const vscode: any = fakeVscode()
    const provider = {
      id: "cognia.acme.tools.kernel",
      kind: "notebook-controller",
      handler: "kernel",
      metadata: { notebookType: "cognia.acme.tools.acme-notebook", supportsExecutionOrder: true },
    }
    const b = broker({
      execute: (cell: any) => {
        if (cell.source === "boom") throw new Error("kernel died")
        return { outputs: [{ items: [{ mime: "text/plain", text: `= ${cell.source}` }] }] }
      },
    })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const cell = (index: any, source: any) => ({
      index,
      kind: 2,
      document: { languageId: "javascript", getText: () => source },
    })
    await vscode.calls.notebookController.executeHandler([cell(0, "2"), cell(1, "boom")], {
      uri: Uri.parse("file:///work/a.acme"),
      notebookType: "x",
    })
    const [first, second] = vscode.calls.executions
    assert.equal(first.executionOrder, 1)
    assert.equal(first.success, true)
    assert.equal(new TextDecoder().decode(first.outputs[0].items[0].data), "= 2")
    assert.equal(second.success, false)
    assert.match(second.outputs[0].items[0].error, /kernel died/)
    assert.deepEqual(b.calls[0].args[0], {
      index: 0,
      kind: "code",
      languageId: "javascript",
      source: "2",
      metadata: undefined,
    })
  })
})

describe("language models and tools", () => {
  class TextPart {
    declare value: any

    constructor(value: any) {
      this.value = value
    }
  }
  class ToolResult {
    declare content: any

    constructor(content: any) {
      this.content = content
    }
  }
  const lmVscode = (registered: any) => ({
    LanguageModelTextPart: TextPart,
    LanguageModelToolResult: ToolResult,
    lm: {
      registerTool: (id: any, tool: any) => ((registered.tool = tool), { dispose() {} }),
      registerLanguageModelChatProvider: (vendor: any, provider: any) => (
        (registered.provider = provider),
        { dispose() {} }
      ),
    },
  })
  const streamingBroker = (answers: any) => ({
    ...broker(answers),
    createInvocationId: () => "inv-1",
  })

  test("a tool's answer reaches VS Code as a LanguageModelToolResult of typed parts", async () => {
    const registered: any = {}
    await registerManagedProviders(
      lmVscode(registered),
      descriptor([{ id: "cognia_acme_tools_echo", kind: "language-model-tool", handler: "tool" }]),
      streamingBroker({
        invoke: { content: [{ $type: "LanguageModelTextPart", value: "echo: hi" }, "plain"] },
      })
    )
    const result = await registered.tool.invoke({ input: { text: "hi" } }, {})
    assert.ok(result instanceof ToolResult)
    assert.deepEqual(
      result.content.map((part: any) => [part instanceof TextPart, part.value]),
      [
        [true, "echo: hi"],
        [true, "plain"],
      ]
    )
  })

  test("a model's typed stream parts survive the broker and are reported", async () => {
    const registered: any = {}
    await registerManagedProviders(
      lmVscode(registered),
      descriptor([
        {
          id: "cognia.acme.tools.model",
          kind: "language-model-chat-provider",
          handler: "model",
          metadata: { vendor: "cognia.acme.tools.vendor" },
        },
      ]),
      streamingBroker({
        provideLanguageModelChatResponse: {
          stream: [{ $type: "LanguageModelTextPart", value: "Hello" }],
        },
      })
    )
    const reported: any[] = []
    await registered.provider.provideLanguageModelChatResponse(
      { id: "m" },
      [],
      {},
      { report: (part: any) => reported.push(part) },
      {}
    )
    assert.equal(reported.length, 1)
    assert.ok(reported[0] instanceof TextPart)
    assert.equal(reported[0].value, "Hello")
  })

  test("a request's messages reach the plugin with their parts, not VS Code's private fields", async () => {
    // VS Code's message class: parts behind a getter over a private field.
    class ChatMessage {
      declare role: any
      declare _content: any
      declare name: any

      constructor(role: any, content: any, name?: any) {
        this.role = role
        this._content = content
        if (name) this.name = name
      }
      get content() {
        return this._content
      }
    }
    const registered: any = {}
    const answers = streamingBroker({
      provideLanguageModelChatResponse: { stream: [] as any[] },
      provideTokenCount: 3,
    })
    await registerManagedProviders(
      lmVscode(registered),
      descriptor([
        {
          id: "cognia.acme.tools.model",
          kind: "language-model-chat-provider",
          handler: "model",
          metadata: { vendor: "cognia.acme.tools.vendor" },
        },
      ]),
      answers
    )
    await registered.provider.provideLanguageModelChatResponse(
      { id: "m" },
      [
        new ChatMessage(1, [new TextPart("abc")], "me"),
        new ChatMessage(2, [{ callId: "c1", name: "search", input: { q: "x" } }]),
        new ChatMessage(1, [
          { callId: "c1", content: [new TextPart("found")] },
          { mimeType: "image/png", data: new Uint8Array([1, 2]) },
        ]),
      ],
      {},
      { report() {} },
      {}
    )
    const [, messages] = answers.calls.find(
      (call: any) => call.operation === "provideLanguageModelChatResponse"
    ).args
    assert.deepEqual(messages, [
      { role: "user", name: "me", content: [{ $type: "LanguageModelTextPart", value: "abc" }] },
      {
        role: "assistant",
        content: [
          { $type: "LanguageModelToolCallPart", callId: "c1", name: "search", input: { q: "x" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            $type: "LanguageModelToolResultPart",
            callId: "c1",
            content: [{ $type: "LanguageModelTextPart", value: "found" }],
          },
          // Bytes travel as a content handle, like every binary argument.
          {
            $type: "LanguageModelDataPart",
            mimeType: "image/png",
            data: { $type: "ContentHandle", size: 2 },
          },
        ],
      },
    ])
    await registered.provider.provideTokenCount(
      { id: "m" },
      new ChatMessage(1, [new TextPart("hi")])
    )
    assert.deepEqual(answers.calls.at(-1).args[1], {
      role: "user",
      content: [{ $type: "LanguageModelTextPart", value: "hi" }],
    })
  })
})
