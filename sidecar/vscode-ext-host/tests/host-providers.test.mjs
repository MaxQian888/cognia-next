// A real extension's language providers, called the way the renderer calls
// them: `extension:call` with the token from `languages:register`, the
// document reported through `workspace:documentOpened`, LSP-style
// arguments, and answers in the wire shapes the renderer converts.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.provider-extension"
const PATH = join(FIXTURES, "provider-extension")
const URI = "file:///tmp/notes.txt"
const TEXT = "hello world\nsecond line\nthird"

const pos = (line, character) => ({ line, character })
const range = (a, b, c, d) => ({ start: pos(a, b), end: pos(c, d) })

async function startProviders() {
  const registrations = []
  const host = startHost(ID, (method, params) => {
    if (method === "languages:register") {
      registrations.push(params)
      return { token: params.token, supported: params.kind !== "callHierarchy" }
    }
    return null
  })
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules: [],
  })
  await host.request("extension:activate", activation(ID, PATH))
  const registration = (kind) => {
    const found = registrations.find((entry) => entry.kind === kind)
    assert.ok(found, `${kind} was registered`)
    return found
  }
  const call = (kind, method, payload, callId) =>
    host.request("extension:call", {
      extensionId: ID,
      token: registration(kind).token,
      method,
      callId,
      payload,
    })
  return { host, registrations, registration, call }
}

test("providers get real documents and answer in wire shapes", async () => {
  const { host, registration, call } = await startProviders()
  try {
    await host.request("workspace:documentOpened", {
      uri: URI,
      languageId: "plaintext",
      version: 1,
      text: TEXT,
    })
    await host.request("window:editorsChanged", {
      editors: [{ id: "e1", uri: URI, selections: [{ anchor: pos(0, 0), active: pos(0, 5) }] }],
      activeId: "e1",
    })

    // Registration metadata reaches the renderer under the names it reads.
    assert.deepEqual(registration("hover").selector, [{ language: "plaintext", scheme: "file" }])
    assert.deepEqual(registration("completionItem").triggerCharacters, ["."])
    assert.deepEqual(registration("signatureHelp").triggerCharacters, ["("])
    assert.deepEqual(registration("signatureHelp").retriggerCharacters, [","])

    assert.deepEqual(
      await call("hover", "provideHover", { uri: URI, version: 1, position: pos(0, 7) }),
      {
        contents: [{ kind: "markdown", value: "**world**" }, "line hello world"],
        range: range(0, 6, 0, 11),
      }
    )

    assert.deepEqual(
      await call("completionItem", "provideCompletionItems", {
        uri: URI,
        version: 1,
        position: pos(0, 1),
        context: { triggerKind: 1, triggerCharacter: "." },
      }),
      {
        isIncomplete: true,
        items: [
          {
            label: "hello",
            // VS Code Keyword (13) goes out as LSP's 14.
            kind: 14,
            documentation: { kind: "markdown", value: "Says hi" },
            insertText: "hello ${1:name}",
            insertTextFormat: 2,
          },
        ],
      }
    )

    assert.deepEqual(
      await call("codeActions", "provideCodeActions", {
        uri: URI,
        version: 1,
        range: range(0, 0, 0, 5),
        context: {
          diagnostics: [{ range: range(0, 0, 0, 5), message: "typo", severity: 1 }],
          only: "quickfix",
          triggerKind: 1,
        },
      }),
      [
        {
          title: "Fix typo",
          kind: "quickfix",
          diagnostics: [{ range: range(0, 0, 0, 5), message: "typo", severity: 1 }],
          edit: { changes: { [URI]: [{ range: range(0, 0, 0, 5), newText: "fixed" }] } },
        },
      ]
    )

    assert.deepEqual(
      await call("definition", "provideDefinition", { uri: URI, position: pos(1, 0) }),
      [{ uri: URI, range: range(0, 0, 0, 0) }]
    )
    assert.deepEqual(await call("foldingRange", "provideFoldingRanges", { uri: URI }), [
      { startLine: 0, endLine: 2, kind: "region" },
    ])
    assert.deepEqual(
      await call("signatureHelp", "provideSignatureHelp", {
        uri: URI,
        position: pos(0, 3),
        context: { triggerKind: 2, triggerCharacter: "(", isRetrigger: false },
      }),
      {
        signatures: [{ label: "greet(()", parameters: [{ label: "name" }] }],
        activeSignature: 0,
        activeParameter: 0,
      }
    )

    // No open document: no answer, rather than a provider called on nothing.
    assert.equal(
      await call("hover", "provideHover", { uri: "file:///nope.txt", position: pos(0, 0) }),
      null
    )
  } finally {
    host.stop()
  }
})

test("a call made against a newer version waits for that edit", async () => {
  const { host, call } = await startProviders()
  try {
    await host.request("workspace:documentOpened", {
      uri: URI,
      languageId: "plaintext",
      version: 1,
      text: TEXT,
    })
    const hover = call("hover", "provideHover", { uri: URI, version: 2, position: pos(0, 1) })
    await host.request("workspace:documentChanged", {
      uri: URI,
      version: 2,
      text: TEXT.replace("hello", "howdy"),
    })
    assert.deepEqual((await hover).contents[0], { kind: "markdown", value: "**howdy**" })

    await host.request("window:editorsChanged", {
      editors: [{ id: "e1", uri: URI, selections: [{ anchor: pos(0, 0), active: pos(0, 3) }] }],
      activeId: "e1",
    })
    const seen = (await call("workspaceSymbol", "provideWorkspaceSymbols", { query: "" })).map(
      (symbol) => symbol.name
    )
    // The edit is reported as the one span that changed.
    assert.deepEqual(seen, ["open:plaintext", "change:2:owdy", "active:3"])
  } finally {
    host.stop()
  }
})

test("hierarchy items come back as the extension's own objects, even where the editor has no view", async () => {
  const { host, call } = await startProviders()
  try {
    await host.request("workspace:documentOpened", {
      uri: URI,
      languageId: "plaintext",
      version: 1,
      text: TEXT,
    })
    const [item] = await call("callHierarchy", "prepareCallHierarchy", {
      uri: URI,
      position: pos(0, 0),
    })
    assert.equal(item.name, "main")
    // SymbolKind.Function is 11 in VS Code's (and Monaco's) numbering.
    assert.equal(item.kind, 11)
    const [incoming] = await call("callHierarchy", "provideIncomingCalls", { item })
    assert.equal(incoming.from.name, "kept on the item")
    assert.deepEqual(incoming.fromRanges, [range(0, 0, 0, 4)])
    assert.ok(host.stderr.some((line) => line.includes("no callHierarchy feature")))
  } finally {
    host.stop()
  }
})

test("cancelling a call cancels the provider's token", async () => {
  const { host, call } = await startProviders()
  try {
    await host.request("workspace:documentOpened", {
      uri: URI,
      languageId: "plaintext",
      version: 1,
      text: TEXT,
    })
    const references = call(
      "references",
      "provideReferences",
      { uri: URI, position: pos(0, 0), context: { includeDeclaration: true } },
      "call-1"
    )
    await host.request("extension:cancel", { callId: "call-1" })
    assert.deepEqual(await references, [{ uri: URI, range: range(9, 9, 9, 9) }])
    await assert.rejects(
      host.request("extension:call", {
        extensionId: ID,
        token: "nope",
        method: "provideHover",
        payload: {},
      }),
      /No provider callback/
    )
  } finally {
    host.stop()
  }
})
