import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RequestCancelledError, createEditorVerbs } from "../src/editor-verbs.mjs"

class FakeRange {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter }
    this.end = { line: endLine, character: endCharacter }
  }
}

class FakeEmitter {
  constructor() {
    this.listeners = []
    this.event = (listener) => this.listeners.push(listener)
    this.disposed = false
  }
  fire(value) {
    for (const listener of this.listeners) listener(value)
  }
  dispose() {
    this.disposed = true
  }
}

function fakeDoc(fsPath, { dirty = false, text = "", save = async () => true } = {}) {
  return {
    uri: { scheme: "file", fsPath, toString: () => `file://${fsPath}` },
    isDirty: dirty,
    isUntitled: false,
    getText: () => text,
    positionAt: (offset) => ({ offset }),
    save,
  }
}

function fakeVscode({ documents = [] } = {}) {
  const calls = { commands: [], sent: [], terminals: [], edits: [], shown: [] }
  const vscode = {
    calls,
    EventEmitter: FakeEmitter,
    Range: FakeRange,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    WorkspaceEdit: class {
      replace(uri, rangeValue, text) {
        calls.edits.push({ uri, text })
      }
    },
    Uri: {
      file: (fsPath) => ({
        scheme: "file",
        fsPath,
        toString: () => `file://${fsPath}`,
        with: ({ scheme }) => ({ scheme, fsPath, toString: () => `${scheme}://${fsPath}` }),
      }),
    },
    workspace: {
      textDocuments: documents,
      openTextDocument: async (uri) => fakeDoc(uri.fsPath),
      applyEdit: async () => true,
      fs: { readFile: async () => Buffer.from("disk text") },
    },
    window: {
      terminals: [],
      activeTextEditor: null,
      showTextDocument: async (doc) => {
        calls.shown.push(doc.uri.fsPath)
        return { revealRange: () => {} }
      },
      createTerminal: (options) => {
        const terminal = {
          name: options.name,
          exitStatus: undefined,
          show: () => {},
          sendText: (text) => calls.sent.push(text),
        }
        calls.terminals.push(terminal)
        return terminal
      },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
    },
    commands: {
      executeCommand: async (...args) => {
        calls.commands.push(args)
      },
    },
    languages: { getDiagnostics: () => [] },
    extensions: { getExtension: () => undefined },
  }
  return vscode
}

const verbsFor = (vscode, overrides = {}) =>
  createEditorVerbs(vscode, {
    onSnapshot: () => {},
    getProxyRegistration: () => undefined,
    ...overrides,
  })

describe("dispatch", () => {
  test("rejects unknown methods, including inherited object keys", async () => {
    const { dispatch } = verbsFor(fakeVscode())
    await assert.rejects(dispatch("bogus", {}), /unknown method: bogus/)
    await assert.rejects(dispatch("toString", {}), /unknown method: toString/)
  })

  test("refuses to start a request that was already withdrawn", async () => {
    const vscode = fakeVscode()
    const { dispatch } = verbsFor(vscode)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      dispatch("openFile", { path: "/a.ts" }, { signal: controller.signal }),
      RequestCancelledError
    )
    assert.deepEqual(vscode.calls.shown, [])
  })
})

describe("saveAll", () => {
  test("reports progress per file and stops at a cancellation", async () => {
    const controller = new AbortController()
    const saved = []
    const docs = ["/a.ts", "/b.ts", "/c.ts"].map((path) =>
      fakeDoc(path, {
        dirty: true,
        save: async () => {
          saved.push(path)
          if (path === "/b.ts") controller.abort()
          return true
        },
      })
    )
    const progress = []
    const { dispatch } = verbsFor(fakeVscode({ documents: docs }))
    await assert.rejects(
      dispatch(
        "saveAll",
        {},
        { signal: controller.signal, reportProgress: (v) => progress.push(v) }
      ),
      RequestCancelledError
    )
    // What was saved stays saved; nothing after the cancellation is touched.
    assert.deepEqual(saved, ["/a.ts", "/b.ts"])
    assert.deepEqual(
      progress.map((v) => [v.kind, v.done ?? null]),
      [
        ["begin", null],
        ["report", 1],
        ["report", 2],
        ["end", null],
      ]
    )
  })

  test("returns what it could and could not save", async () => {
    const docs = [
      fakeDoc("/ok.ts", { dirty: true }),
      fakeDoc("/no.ts", { dirty: true, save: async () => false }),
      fakeDoc("/clean.ts"),
    ]
    const { dispatch } = verbsFor(fakeVscode({ documents: docs }))
    assert.deepEqual(await dispatch("saveAll", {}), { saved: ["/ok.ts"], failed: ["/no.ts"] })
  })
})

describe("runInTerminal", () => {
  test("never types a command for a withdrawn request", async () => {
    const vscode = fakeVscode()
    const controller = new AbortController()
    vscode.window.createTerminal = (options) => {
      controller.abort()
      return { name: options.name, show: () => {}, sendText: (t) => vscode.calls.sent.push(t) }
    }
    const { dispatch } = verbsFor(vscode)
    await assert.rejects(
      dispatch("runInTerminal", { command: "rm -rf build" }, { signal: controller.signal }),
      RequestCancelledError
    )
    assert.deepEqual(vscode.calls.sent, [])
  })

  test("types the command into the named terminal", async () => {
    const vscode = fakeVscode()
    const { dispatch } = verbsFor(vscode)
    assert.deepEqual(await dispatch("runInTerminal", { command: "pnpm test" }), {
      sent: true,
      terminal: "Cognia",
    })
    assert.deepEqual(vscode.calls.sent, ["pnpm test"])
  })
})

describe("applyEdit", () => {
  test("reflects a stale buffer as an edit, then reveals, bracketed by progress", async () => {
    const doc = fakeDoc("/work/a.ts", { text: "old" })
    const vscode = fakeVscode({ documents: [doc] })
    const progress = []
    const { dispatch } = verbsFor(vscode)
    const result = await dispatch(
      "applyEdit",
      { path: "/work/a.ts" },
      { reportProgress: (v) => progress.push(v.kind) }
    )
    assert.deepEqual(result, { reflected: true, opened: true, path: "/work/a.ts" })
    assert.equal(vscode.calls.edits[0].text, "disk text")
    assert.deepEqual(progress, ["begin", "end"])
  })

  test("refuses to overwrite unsaved user changes", async () => {
    const doc = fakeDoc("/work/a.ts", { text: "user draft", dirty: true })
    const { dispatch } = verbsFor(fakeVscode({ documents: [doc] }))
    await assert.rejects(dispatch("applyEdit", { path: "/work/a.ts" }), /DIRTY_DOCUMENT_CONFLICT/)
  })
})

describe("showDiff", () => {
  test("serves the proposal from memory under the proposed scheme", async () => {
    const vscode = fakeVscode()
    const verbs = verbsFor(vscode)
    await verbs.dispatch("showDiff", { path: "/work/a.ts", content: "proposed" })
    const [command, , right, title] = vscode.calls.commands[0]
    assert.equal(command, "vscode.diff")
    assert.equal(right.scheme, "cognia-proposed")
    assert.equal(title, "a.ts — proposed")
    assert.equal(verbs.proposedProvider.provideTextDocumentContent(right), "proposed")
    verbs.dispose()
    assert.equal(verbs.proposedProvider.provideTextDocumentContent(right), "")
  })
})

describe("restartManagedExtensionHost", () => {
  const restartWith = async (available) => {
    const executed = []
    const vscode = fakeVscode()
    vscode.commands = {
      getCommands: async () => available,
      executeCommand: async (command) => executed.push(command),
    }
    await verbsFor(vscode).dispatch("restartManagedExtensionHost", {})
    return executed
  }

  test("restarts the extension host where the workbench can", async () => {
    assert.deepEqual(await restartWith(["workbench.action.restartExtensionHost"]), [
      "workbench.action.restartExtensionHost",
    ])
  })

  test("reloads code-server's web workbench, which has no restart command", async () => {
    assert.deepEqual(await restartWith(["workbench.action.reloadWindow"]), [
      "workbench.action.reloadWindow",
    ])
  })
})

describe("workspaceSnapshot and the proxy handshake", () => {
  test("hands a snapshot to its sink and refuses a non-object", async () => {
    const received = []
    const { dispatch } = verbsFor(fakeVscode(), { onSnapshot: (s) => received.push(s) })
    await dispatch("workspaceSnapshot", { statusText: "3 issues" })
    assert.deepEqual(received, [{ statusText: "3 issues" }])
    await assert.rejects(dispatch("workspaceSnapshot", "nope"), /requires an object/)
  })

  test("verifies the activated proxy against the staged descriptor", async () => {
    const descriptor = {
      pluginVersion: "1.0.0",
      manifestHash: "sha256:m",
      catalogHash: "sha256:c",
      platformVersion: "1.0.0",
      providers: [{}],
    }
    const vscode = fakeVscode()
    vscode.extensions.getExtension = (id) =>
      id === "cognia-managed.proxy-acme-tools"
        ? { isActive: true, packageJSON: { cogniaManaged: descriptor } }
        : undefined
    const progress = []
    const { dispatch } = verbsFor(vscode, { getProxyRegistration: () => ({}) })
    const params = { pluginId: "acme.tools", ...descriptor }
    const result = await dispatch("managedProxyHandshake", params, {
      reportProgress: (v) => progress.push(v.kind),
    })
    assert.equal(result.providerCount, 1)
    assert.deepEqual(progress, ["begin", "end"])
    await assert.rejects(
      dispatch("managedProxyHandshake", { ...params, manifestHash: "sha256:other" }),
      /IDE_PROXY_HANDSHAKE_MISMATCH: manifestHash/
    )
  })

  test("waits for VS Code to discover a just-installed proxy, then gives up in bounded time", async () => {
    const descriptor = {
      pluginVersion: "1.0.0",
      manifestHash: "sha256:m",
      catalogHash: "sha256:c",
      platformVersion: "1.0.0",
    }
    const vscode = fakeVscode()
    const listeners = new Set()
    const changed = {
      fire: () => [...listeners].forEach((listener) => listener()),
      event: (listener) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    }
    let installed = false
    vscode.extensions = {
      getExtension: () =>
        installed ? { isActive: true, packageJSON: { cogniaManaged: descriptor } } : undefined,
      onDidChange: changed.event,
    }
    const params = { pluginId: "acme.tools", ...descriptor }
    const { dispatch } = verbsFor(vscode, {
      getProxyRegistration: () => ({}),
      proxyDiscoveryTimeoutMs: 1_000,
    })
    const pending = dispatch("managedProxyHandshake", params)
    changed.fire()
    installed = true
    changed.fire()
    assert.equal((await pending).pluginVersion, "1.0.0")

    installed = false
    const quick = verbsFor(vscode, {
      getProxyRegistration: () => ({}),
      proxyDiscoveryTimeoutMs: 20,
    })
    await assert.rejects(
      quick.dispatch("managedProxyHandshake", params),
      /IDE_PROXY_EXTENSION_NOT_DISCOVERED: acme.tools/
    )

    const controller = new AbortController()
    const cancelled = verbsFor(vscode, { getProxyRegistration: () => ({}) }).dispatch(
      "managedProxyHandshake",
      params,
      { signal: controller.signal }
    )
    controller.abort()
    await assert.rejects(cancelled, (error) => error.name === "RequestCancelledError")
    // Every wait let go of its listener.
    assert.equal(listeners.size, 0)
  })
})
