// The unsupported members of `window`, `workspace` and `languages`: mounted,
// behaving as `unsupported.ts` says, and reported to the renderer once each.
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  createUnsupportedApiReporter,
  createUnsupportedLanguagesMembers,
  createUnsupportedWindowMembers,
  createUnsupportedWorkspaceMembers,
} from "../dist/vscode-shim/unsupported-members.js"
import { UNSUPPORTED_VSCODE_API, unsupportedReason } from "../dist/vscode-shim/unsupported.js"
import { NotSupportedError } from "../dist/vscode-shim/types.js"

function reporting() {
  const sent = []
  const reporter = createUnsupportedApiReporter(
    {
      sendRequest: async (method, params) => {
        sent.push({ method, params })
        return null
      },
    },
    "cognia.example"
  )
  return { sent, reporter }
}

test("every member is described in unsupported.ts", () => {
  const { reporter } = reporting()
  const members = {
    window: createUnsupportedWindowMembers(reporter),
    workspace: createUnsupportedWorkspaceMembers(reporter),
    languages: createUnsupportedLanguagesMembers(reporter),
  }
  for (const [namespace, object] of Object.entries(members)) {
    for (const member of Object.keys(object)) {
      assert.ok(UNSUPPORTED_VSCODE_API[`${namespace}.${member}`], `${namespace}.${member}`)
    }
  }
})

test("registrations return a disposable and are reported once", () => {
  const { sent, reporter } = reporting()
  const window = createUnsupportedWindowMembers(reporter)
  const first = window.registerTreeDataProvider("view", {})
  window.registerTreeDataProvider("other", {})
  assert.equal(typeof first.dispose, "function")
  assert.deepEqual(sent, [
    {
      method: "vscode:unsupportedApi",
      params: { extensionId: "cognia.example", api: "window.registerTreeDataProvider" },
    },
  ])
})

test("events never fire, and join the given disposables", () => {
  const { sent, reporter } = reporting()
  const workspace = createUnsupportedWorkspaceMembers(reporter)
  const disposables = []
  const subscription = workspace.onWillSaveTextDocument(
    () => assert.fail("fired"),
    null,
    disposables
  )
  assert.deepEqual(disposables, [subscription])
  assert.equal(sent[0].params.api, "workspace.onWillSaveTextDocument")
})

test("calls that must produce something fail with the reason", async () => {
  const { reporter } = reporting()
  const workspace = createUnsupportedWorkspaceMembers(reporter)
  await assert.rejects(workspace.saveAs(), (error) => {
    assert.ok(error instanceof NotSupportedError)
    assert.equal(
      error.message,
      `vscode.workspace.saveAs is not supported in Cognia: ${UNSUPPORTED_VSCODE_API["workspace.saveAs"]}`
    )
    return true
  })
  const window = createUnsupportedWindowMembers(reporter)
  await assert.rejects(window.showNotebookDocument({}), NotSupportedError)
  assert.throws(() => window.tabGroups.all, /window\.tabGroups\.all is not supported/)
  await assert.rejects(window.tabGroups.close(), NotSupportedError)
})

test("a tree view and a language status item exist but are never shown", async () => {
  const { reporter } = reporting()
  const view = createUnsupportedWindowMembers(reporter).createTreeView("files", {})
  assert.deepEqual([view.visible, view.selection], [false, []])
  view.onDidChangeVisibility(() => assert.fail("fired"))
  await assert.rejects(view.reveal({}), NotSupportedError)

  const item = createUnsupportedLanguagesMembers(reporter).createLanguageStatusItem("lint", "*")
  item.text = "ok"
  assert.deepEqual([item.id, item.text], ["lint", "ok"])
})

test("withScmProgress runs its task", async () => {
  const { reporter } = reporting()
  const window = createUnsupportedWindowMembers(reporter)
  assert.equal(
    await window.withScmProgress(async (progress) => {
      progress.report(5)
      return "done"
    }),
    "done"
  )
})

test("the notebook editor lists are empty", () => {
  const { reporter } = reporting()
  const window = createUnsupportedWindowMembers(reporter)
  assert.equal(window.activeNotebookEditor, undefined)
  assert.deepEqual(window.visibleNotebookEditors, [])
  assert.deepEqual(createUnsupportedWorkspaceMembers(reporter).notebookDocuments, [])
})

test("a member's reason falls back to its namespace's", () => {
  assert.equal(unsupportedReason("debug.startDebugging"), UNSUPPORTED_VSCODE_API.debug)
  assert.equal(unsupportedReason("window.showInformationMessage"), undefined)
  assert.equal(
    new NotSupportedError("debug.startDebugging").message,
    "vscode.debug.startDebugging is not supported in Cognia: Cognia has no debugger."
  )
})
