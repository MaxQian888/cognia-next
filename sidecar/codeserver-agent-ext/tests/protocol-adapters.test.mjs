import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"

import { applyLspWorkspaceEdit, registerManagedProtocols } from "../src/protocol-adapters.mjs"

function disposable() {
  return { dispose() {} }
}

function fakeVscode() {
  const registered = []
  const languages = new Proxy(
    {
      createDiagnosticCollection: () => ({ set() {}, dispose() {} }),
    },
    {
      get(target, key) {
        if (key in target) return target[key]
        if (String(key).startsWith("register")) {
          return (...args) => {
            registered.push({ method: key, args })
            return disposable()
          }
        }
      },
    }
  )
  return {
    registered,
    vscode: {
      languages,
      workspace: {
        textDocuments: [],
        workspaceFolders: [],
        applyEdit: async () => true,
        fs: { readFile: async () => new Uint8Array() },
        onDidOpenTextDocument: () => disposable(),
        onDidChangeTextDocument: () => disposable(),
        onDidCloseTextDocument: () => disposable(),
      },
      debug: {
        registerDebugAdapterDescriptorFactory: () => disposable(),
        onDidTerminateDebugSession: () => disposable(),
      },
      lm: {
        registerMcpServerDefinitionProvider: () => disposable(),
      },
      window: {
        withProgress: async (_options, task) =>
          task({ report() {} }, { onCancellationRequested: () => disposable() }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showTextDocument: async () => undefined,
      },
      env: { openExternal: async () => true },
      ProgressLocation: { Notification: 15 },
      Disposable: {
        from: (...items) => ({ dispose: () => items.forEach((item) => item.dispose()) }),
      },
      Uri: {
        parse: (value) => ({
          value,
          toString: () => value,
        }),
      },
      Range: class {},
      TextEdit: { replace: (range, newText) => ({ range, newText }) },
      WorkspaceEdit: class {
        set() {}
        createFile() {}
        renameFile() {}
        deleteFile() {}
      },
      Diagnostic: class {},
      EventEmitter: class {
        event = () => disposable()
        fire() {}
        dispose() {}
      },
      DebugAdapterServer: class {},
      DebugAdapterInlineImplementation: class {},
      McpHttpServerDefinition: class {},
      SemanticTokensLegend: class {},
      SemanticTokens: class {},
      SemanticTokensEdits: class {},
      SemanticTokensEdit: class {},
    },
  }
}

test("LSP declarations start a Cognia-owned session and register native Code providers", async () => {
  const { vscode, registered } = fakeVscode()
  const starts = []
  const startProtocol = async (...args) => {
    starts.push(args)
    return { capabilityTicket: "ticket" }
  }
  const registration = await registerManagedProtocols(
    vscode,
    {
      protocols: {
        lsp: [
          {
            id: "cognia.acme.language",
            executable: "server",
            transport: "stdio",
            languages: ["typescript"],
          },
        ],
        dap: [],
        mcp: [],
      },
    },
    {
      startProtocol,
      requestProtocol: async () => null,
      documentProtocol: async () => null,
      stopProtocol: async () => null,
      onEvent: () => disposable(),
    }
  )
  assert.ok(registered.some((entry) => entry.method === "registerHoverProvider"))
  assert.ok(registered.some((entry) => entry.method === "registerRenameProvider"))
  assert.ok(registered.some((entry) => entry.method === "registerCallHierarchyProvider"))
  assert.equal(starts[0][2], "pro-ide")
  registration.dispose()
})

test("LSP semantic-token capabilities are projected with the server legend", async () => {
  const { vscode, registered } = fakeVscode()
  const registration = await registerManagedProtocols(
    vscode,
    {
      protocols: {
        lsp: [
          {
            id: "cognia.acme.language",
            executable: "server",
            transport: "stdio",
            languages: ["typescript"],
          },
        ],
        dap: [],
        mcp: [],
      },
    },
    {
      startProtocol: async () => ({
        capabilityTicket: "ticket",
        connection: {
          capabilities: {
            semanticTokensProvider: {
              legend: { tokenTypes: ["class"], tokenModifiers: ["declaration"] },
              full: { delta: true },
              range: true,
            },
          },
        },
      }),
      requestProtocol: async () => ({ data: [] }),
      documentProtocol: async () => null,
      stopProtocol: async () => null,
      onEvent: () => disposable(),
    }
  )
  assert.ok(registered.some((entry) => entry.method === "registerDocumentSemanticTokensProvider"))
  assert.ok(
    registered.some((entry) => entry.method === "registerDocumentRangeSemanticTokensProvider")
  )
  registration.dispose()
})

test("DAP and MCP declarations register native surfaces without launching plugin code", async () => {
  const { vscode } = fakeVscode()
  await assert.doesNotReject(
    registerManagedProtocols(vscode, {
      protocols: {
        lsp: [],
        dap: [{ id: "cognia.acme.debug" }],
        mcp: [{ id: "cognia.acme.tools" }],
      },
    })
  )
})

test("workspace edits require matching version and content-hash preconditions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cognia-lsp-edit-"))
  const previousRoot = process.env.COGNIA_CS_WORKSPACE
  process.env.COGNIA_CS_WORKSPACE = root
  const file = join(root, "a.ts")
  const text = "const value = 1\n"
  await writeFile(file, text)
  const uri = pathToFileURL(file).toString()
  const { vscode } = fakeVscode()
  vscode.workspace.textDocuments.push({
    uri: { toString: () => uri },
    version: 3,
    getText: () => text,
  })
  let applied = 0
  vscode.workspace.applyEdit = async () => {
    applied += 1
    return true
  }
  try {
    await assert.doesNotReject(
      applyLspWorkspaceEdit(
        vscode,
        {
          edit: {
            changes: {
              [uri]: [
                {
                  range: {
                    start: { line: 0, character: 14 },
                    end: { line: 0, character: 15 },
                  },
                  newText: "2",
                },
              ],
            },
          },
        },
        {
          [uri]: {
            exists: true,
            version: 3,
            contentHash: createHash("sha256").update(text).digest("hex"),
          },
        }
      )
    )
    assert.equal(applied, 1)
    await assert.rejects(
      applyLspWorkspaceEdit(
        vscode,
        { edit: { changes: { [uri]: [] } } },
        {
          [uri]: {
            exists: true,
            version: 2,
            contentHash: createHash("sha256").update(text).digest("hex"),
          },
        }
      ),
      /IDE_WORKSPACE_EDIT_VERSION_CONFLICT/
    )
    assert.equal(applied, 1)
  } finally {
    if (previousRoot === undefined) delete process.env.COGNIA_CS_WORKSPACE
    else process.env.COGNIA_CS_WORKSPACE = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace edit confinement rejects a symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "cognia-lsp-root-"))
  const outside = await mkdtemp(join(tmpdir(), "cognia-lsp-outside-"))
  const previousRoot = process.env.COGNIA_CS_WORKSPACE
  process.env.COGNIA_CS_WORKSPACE = root
  const outsideFile = join(outside, "secret.ts")
  await writeFile(outsideFile, "secret\n")
  await symlink(outside, join(root, "escape"))
  const uri = pathToFileURL(join(root, "escape", "secret.ts")).toString()
  const { vscode } = fakeVscode()
  try {
    await assert.rejects(
      applyLspWorkspaceEdit(
        vscode,
        { edit: { changes: { [uri]: [] } } },
        {
          [uri]: {
            exists: true,
            contentHash: createHash("sha256").update("secret\n").digest("hex"),
          },
        }
      ),
      /IDE_PATH_OUTSIDE_WORKSPACE/
    )
  } finally {
    if (previousRoot === undefined) delete process.env.COGNIA_CS_WORKSPACE
    else process.env.COGNIA_CS_WORKSPACE = previousRoot
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
