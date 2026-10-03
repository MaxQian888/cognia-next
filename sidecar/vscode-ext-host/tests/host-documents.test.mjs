// `vscode.workspace`'s documents and `window.showTextDocument` through the
// real host: the test plays the renderer, which owns the text and reports
// documents and editors back to the host.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.documents-extension"
const PATH = join(FIXTURES, "documents-extension")

async function startDocuments() {
  const commands = new Map()
  const requests = []
  const versions = new Map()
  const disk = new Map([["file:///repo/a.ts", "abcd"]])
  let host
  const report = (method, params) => host.request(method, params)
  host = startHost(ID, async (method, params) => {
    requests.push({ method, params })
    switch (method) {
      case "commands:register":
        commands.set(params.command, params.token)
        return { registered: true }
      case "workspace:openTextDocument": {
        const uri = params.untitled ? "untitled:Untitled-1" : params.uri
        const text = params.untitled ? params.untitled.content : disk.get(uri)
        const languageId = params.untitled ? params.untitled.language : "typescript"
        versions.set(uri, 1)
        await report("workspace:documentOpened", { uri, languageId, version: 1, text })
        return { uri, version: 1 }
      }
      case "workspace:applyEdit": {
        const edit = params.edit.operations.find((operation) => operation.kind === "edit")
        const version = versions.get(edit.uri) + 1
        versions.set(edit.uri, version)
        // The report lands after the answer, as it can in the app.
        setTimeout(
          () =>
            report("workspace:documentChanged", {
              uri: edit.uri,
              version,
              text: edit.edits[0].newText + disk.get(edit.uri),
            }),
          30
        )
        return { applied: true, versions: { [edit.uri]: version } }
      }
      case "window:showTextDocument":
        setTimeout(
          () =>
            report("window:editorsChanged", {
              editors: [
                {
                  id: "e1",
                  uri: params.uri,
                  selections: [
                    { anchor: { line: 0, character: 1 }, active: { line: 0, character: 1 } },
                  ],
                },
              ],
              activeId: "e1",
            }),
          30
        )
        return { uri: params.uri }
      case "window:editorEdit": {
        const uri = "file:///repo/a.ts"
        const version = versions.get(uri) + 1
        versions.set(uri, version)
        setTimeout(() => report("workspace:documentChanged", { uri, version, text: "!>abcd" }), 30)
        return { applied: true, version }
      }
      default:
        return null
    }
  })
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules: [],
  })
  await host.request("extension:activate", activation(ID, PATH))
  const run = (command, ...args) =>
    host.request("extension:call", { extensionId: ID, token: commands.get(command), payload: args })
  const notifications = (method) => host.notifications.filter((frame) => frame.method === method)
  return { host, run, requests, notifications, report }
}

test("open, edit, show and save documents the renderer owns", async () => {
  const { host, run, requests, notifications, report } = await startDocuments()
  try {
    assert.deepEqual(await run("documentsFixture.open", "/repo/a.ts"), {
      uri: "file:///repo/a.ts",
      text: "abcd",
      languageId: "typescript",
    })
    assert.deepEqual(await run("documentsFixture.untitled"), {
      uri: "untitled:Untitled-1",
      text: "draft",
      isUntitled: true,
    })
    assert.deepEqual(
      requests.find(
        (entry) => entry.method === "workspace:openTextDocument" && entry.params.untitled
      ).params.untitled,
      { content: "draft", language: "markdown" }
    )

    // The edit's steps go in order; the answer waits for the edit to land.
    assert.deepEqual(await run("documentsFixture.applyEdit", "/repo/a.ts"), {
      applied: true,
      text: ">abcd",
    })
    const operations = requests.find((entry) => entry.method === "workspace:applyEdit").params.edit
      .operations
    assert.deepEqual(operations, [
      { kind: "create", uri: "file:///repo/a.ts.new", contents: { text: "made" }, options: {} },
      {
        kind: "edit",
        uri: "file:///repo/a.ts",
        edits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: ">",
          },
        ],
      },
    ])

    const shown = await run("documentsFixture.show", "/repo/a.ts")
    assert.deepEqual(shown, { editorId: "e1", edited: true, text: "!>abcd", selection: [1, 3] })
    assert.deepEqual(
      requests.find((entry) => entry.method === "window:showTextDocument").params.selection,
      { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }
    )
    assert.deepEqual(notifications("window:setSelections").at(-1).params.selections, [
      { anchor: { line: 0, character: 1 }, active: { line: 0, character: 3 } },
    ])

    // The content provider answers the renderer's call, and reports changes.
    const registered = requests.find(
      (entry) => entry.method === "workspace:registerTextDocumentContentProvider"
    ).params
    assert.equal(registered.scheme, "fixture")
    assert.equal(
      await host.request("extension:call", {
        extensionId: ID,
        token: registered.token,
        method: "provideTextDocumentContent",
        payload: { uri: "fixture:/notes" },
      }),
      "content of /notes"
    )
    await run("documentsFixture.changeContent")
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(notifications("workspace:textDocumentContentChanged").at(-1).params, {
      extensionId: ID,
      scheme: "fixture",
      uri: "fixture:/x",
    })

    await report("workspace:documentSaved", { uri: "file:///repo/a.ts" })
    assert.deepEqual(await run("documentsFixture.saved"), ["file:///repo/a.ts"])
  } finally {
    host.stop()
  }
})
