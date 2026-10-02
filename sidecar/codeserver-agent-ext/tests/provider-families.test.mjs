import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { registerManagedProviders } from "../src/provider-adapters.mjs"

// The SCM, testing and notebook adapters used to register a shell and forward
// one call: no resource groups, no reported test outcomes, no cell outputs.
// These pin what each now does with the plugin's answers.

const descriptor = (providers) => ({
  pluginId: "acme.tools",
  pluginVersion: "1.0.0",
  manifestHash: "sha256:m",
  catalogHash: "sha256:c",
  platformVersion: "1.0.0",
  providers,
})

class Uri {
  constructor(parts) {
    Object.assign(this, parts)
  }
  static parse(value) {
    const [scheme, rest] = value.split("://")
    return new Uri({ scheme, authority: "", path: rest ?? "", query: "", fragment: "" })
  }
  static from(parts) {
    return new Uri(parts)
  }
  toString() {
    return `${this.scheme}://${this.path}`
  }
}

function emitter() {
  const listeners = []
  const event = (listener) => {
    listeners.push(listener)
    return { dispose() {} }
  }
  return { event, fire: (value) => listeners.forEach((listener) => listener(value)) }
}

function fakeVscode() {
  const calls = { scm: null, commands: new Map(), watchers: [], runs: [], executions: [] }
  const vscode = {
    calls,
    Uri,
    RelativePattern: class {
      constructor(base, pattern) {
        Object.assign(this, { base, pattern })
      }
    },
    Disposable: {
      from: (...items) => ({ dispose: () => items.forEach((item) => item.dispose()) }),
    },
    commands: {
      registerCommand(id, handler) {
        calls.commands.set(id, handler)
        return { dispose: () => calls.commands.delete(id) }
      },
    },
    workspace: {
      createFileSystemWatcher(pattern) {
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
      registerNotebookSerializer(type, serializer) {
        calls.serializer = { type, serializer }
        return { dispose() {} }
      },
    },
    scm: {
      createSourceControl(id, label, rootUri) {
        const groups = []
        calls.scm = {
          id,
          label,
          rootUri,
          groups,
          inputBox: { value: "", placeholder: "" },
          count: undefined,
          createResourceGroup(groupId, groupLabel) {
            const group = {
              id: groupId,
              label: groupLabel,
              resourceStates: [],
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
      constructor(id) {
        this.id = id
      }
    },
    TestMessage: class {
      constructor(message) {
        this.message = message
      }
    },
    tests: {
      createTestController(id, label) {
        const items = new Map()
        const collection = {
          replace(next) {
            items.clear()
            for (const item of next) items.set(item.id, item)
          },
          forEach: (fn) => items.forEach((item) => fn(item)),
        }
        const controller = {
          id,
          label,
          items: collection,
          profiles: [],
          createTestItem: (itemId, itemLabel) => ({
            id: itemId,
            label: itemLabel,
            children: { forEach() {}, replace() {} },
          }),
          createRunProfile(profileLabel, kind, handler) {
            controller.profiles.push({ label: profileLabel, kind, handler })
          },
          createTestRun(request, name) {
            const run = { request, name, events: [], output: "" }
            for (const method of [
              "enqueued",
              "started",
              "passed",
              "failed",
              "errored",
              "skipped",
            ]) {
              run[method] = (item, ...rest) => run.events.push([method, item.id, ...rest])
            }
            run.appendOutput = (text) => (run.output += text)
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
      constructor(kind, value, languageId) {
        Object.assign(this, { kind, value, languageId })
      }
    },
    NotebookData: class {
      constructor(cells) {
        this.cells = cells
      }
    },
    NotebookCellOutputItem: Object.assign(
      class {
        constructor(data, mime) {
          Object.assign(this, { data, mime })
        }
      },
      {
        text: (text, mime) => ({ mime, data: new TextEncoder().encode(text) }),
        error: (error) => ({ mime: "application/vnd.code.notebook.error", error: String(error) }),
      }
    ),
    NotebookCellOutput: class {
      constructor(items, metadata) {
        Object.assign(this, { items, metadata })
      }
    },
    notebooks: {
      createNotebookController(id, type, label) {
        const controller = {
          id,
          type,
          label,
          createNotebookCellExecution(cell) {
            const execution = {
              cell,
              token: { isCancellationRequested: false },
              outputs: null,
              start: (at) => (execution.startedAt = at),
              replaceOutput: async (outputs) => (execution.outputs = outputs),
              end: (success) => (execution.success = success),
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

function broker(answers) {
  const calls = []
  let onEvent = null
  return {
    calls,
    emit: (message) => onEvent?.(message),
    invoke: async (provider, operation, args) => {
      calls.push({ operation, args })
      const answer = answers[operation]
      return typeof answer === "function" ? answer(...args) : answer
    },
    onEvent(listener) {
      onEvent = listener
      return { dispose: () => (onEvent = null) }
    },
    // Binary arguments travel as content handles, as through the real broker.
    createContent: async (_provider, bytes) => ({ $type: "ContentHandle", size: bytes.length }),
  }
}

/** Run events with any TestMessage reduced to its text, for comparison. */
const plain = (events) =>
  events.map((event) => event.map((part) => (part?.message !== undefined ? part.message : part)))

describe("source control", () => {
  const provider = {
    id: "cognia.acme.tools.scm",
    kind: "source-control",
    handler: "scm",
    metadata: { label: "Acme VCS", rootUri: "file:///work", inputPlaceholder: "Message" },
  }

  test("shows the plugin's groups and resources, and keeps them current", async () => {
    const vscode = fakeVscode()
    let state = {
      groups: [
        {
          id: "changes",
          label: "Changes",
          resources: [{ uri: "file:///work/a.ts", tooltip: "Modified" }],
        },
        { id: "staged", label: "Staged", resources: [] },
      ],
    }
    const b = broker({ initialize: null, status: () => state })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const scm = vscode.calls.scm
    assert.equal(scm.label, "Acme VCS")
    assert.equal(scm.rootUri.toString(), "file:///work")
    assert.equal(scm.inputBox.placeholder, "Message")
    assert.deepEqual(
      b.calls.map((call) => call.operation),
      ["initialize", "status"]
    )
    assert.equal(scm.groups[0].resourceStates[0].resourceUri.toString(), "file:///work/a.ts")
    assert.equal(scm.groups[0].resourceStates[0].decorations.tooltip, "Modified")
    assert.equal(scm.count, 1)

    // A plugin-sent change drops a group that is gone and recounts.
    state = { groups: [{ id: "changes", label: "Changes", resources: [] }], count: 0 }
    b.emit({ providerId: provider.id, event: "changed" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(scm.groups[1].disposed, true)
    assert.equal(scm.count, 0)
  })

  test("commits the input box, clears it and re-reads status", async () => {
    const vscode = fakeVscode()
    const b = broker({ initialize: null, status: { groups: [] }, commit: null })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const scm = vscode.calls.scm
    assert.equal(scm.acceptInputCommand.command, `${provider.id}.acceptInput`)
    scm.inputBox.value = "fix: it"
    await vscode.calls.commands.get(`${provider.id}.acceptInput`)()
    assert.deepEqual(
      b.calls.slice(-2).map((call) => [call.operation, call.args]),
      [
        ["commit", ["fix: it"]],
        ["status", []],
      ]
    )
    assert.equal(scm.inputBox.value, "")
  })

  test("serves quick diff from the plugin's original resource", async () => {
    const vscode = fakeVscode()
    const b = broker({
      initialize: null,
      status: { groups: [] },
      originalResource: "acme://base/a.ts",
    })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const original = await vscode.calls.scm.quickDiffProvider.provideOriginalResource(
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

  async function setUp(answers) {
    const vscode = fakeVscode()
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
    await vscode.calls.controller.profiles[0].handler({ include: undefined, exclude: [] }, {})
    const run = vscode.calls.runs[0]
    const outcomes = plain(run.events.filter(([kind]) => !["enqueued", "started"].includes(kind)))
    assert.deepEqual(outcomes, [
      ["passed", "t1", 3],
      ["failed", "t2", "expected 1, got 2", undefined],
      ["skipped", "t3"],
      ["end"],
    ])
    assert.equal(run.output, "ran 2\r\n")
    assert.deepEqual(b.calls.at(-1).args[0], { profile: "Run", include: undefined, exclude: [] })
  })

  test("a failed run errors every test it did not settle and still ends", async () => {
    const { vscode } = await setUp({
      resolve: [{ id: "t1", label: "adds" }],
      run: () => {
        throw new Error("runner crashed")
      },
    })
    await vscode.calls.controller.profiles[0].handler({ include: undefined, exclude: [] }, {})
    const run = vscode.calls.runs[0]
    assert.deepEqual(plain(run.events.slice(-2)), [["errored", "t1", "runner crashed"], ["end"]])
  })
})

describe("notebooks", () => {
  test("deserializes into NotebookData and serializes text back to bytes", async () => {
    const vscode = fakeVscode()
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
      serialize: (summary) => JSON.stringify(summary.cells.map((cell) => cell.value)),
    })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const { serializer } = vscode.calls.serializer
    const data = await serializer.deserializeNotebook(new Uint8Array(), {})
    assert.deepEqual(
      data.cells.map((cell) => [cell.kind, cell.value, cell.languageId]),
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
    const vscode = fakeVscode()
    const provider = {
      id: "cognia.acme.tools.kernel",
      kind: "notebook-controller",
      handler: "kernel",
      metadata: { notebookType: "cognia.acme.tools.acme-notebook", supportsExecutionOrder: true },
    }
    const b = broker({
      execute: (cell) => {
        if (cell.source === "boom") throw new Error("kernel died")
        return { outputs: [{ items: [{ mime: "text/plain", text: `= ${cell.source}` }] }] }
      },
    })
    await registerManagedProviders(vscode, descriptor([provider]), b)
    const cell = (index, source) => ({
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
    constructor(value) {
      this.value = value
    }
  }
  class ToolResult {
    constructor(content) {
      this.content = content
    }
  }
  const lmVscode = (registered) => ({
    LanguageModelTextPart: TextPart,
    LanguageModelToolResult: ToolResult,
    lm: {
      registerTool: (id, tool) => ((registered.tool = tool), { dispose() {} }),
      registerLanguageModelChatProvider: (vendor, provider) => (
        (registered.provider = provider),
        { dispose() {} }
      ),
    },
  })
  const streamingBroker = (answers) => ({
    ...broker(answers),
    createInvocationId: () => "inv-1",
  })

  test("a tool's answer reaches VS Code as a LanguageModelToolResult of typed parts", async () => {
    const registered = {}
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
      result.content.map((part) => [part instanceof TextPart, part.value]),
      [
        [true, "echo: hi"],
        [true, "plain"],
      ]
    )
  })

  test("a model's typed stream parts survive the broker and are reported", async () => {
    const registered = {}
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
    const reported = []
    await registered.provider.provideLanguageModelChatResponse(
      { id: "m" },
      [],
      {},
      { report: (part) => reported.push(part) },
      {}
    )
    assert.equal(reported.length, 1)
    assert.ok(reported[0] instanceof TextPart)
    assert.equal(reported[0].value, "Hello")
  })

  test("a request's messages reach the plugin with their parts, not VS Code's private fields", async () => {
    // VS Code's message class: parts behind a getter over a private field.
    class ChatMessage {
      constructor(role, content, name) {
        this.role = role
        this._content = content
        if (name) this.name = name
      }
      get content() {
        return this._content
      }
    }
    const registered = {}
    const answers = streamingBroker({
      provideLanguageModelChatResponse: { stream: [] },
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
      (call) => call.operation === "provideLanguageModelChatResponse"
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
