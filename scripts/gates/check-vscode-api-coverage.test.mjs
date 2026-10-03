// The VS Code API coverage gate's parsing and classification, on small
// declarations and shims.
import assert from "node:assert/strict"
import { test } from "node:test"

import { classify, declaredApi, inertDependencies } from "./check-vscode-api-coverage.mjs"

const DECLARATIONS = `
declare module 'vscode' {
  export const version: string;
  export class Position { constructor(line: number, character: number); }
  export enum ViewColumn { One = 1 }
  export interface TextDocument { uri: string }
  export type Thenable<T> = PromiseLike<T>;
  export namespace window {
    export function showInformationMessage(message: string): void;
    export function showInformationMessage(message: string, modal: boolean): void;
    export const onDidChangeActiveTextEditor: unknown;
    export let activeTextEditor: unknown;
    export function createTreeView(id: string): unknown;
  }
  namespace comments {
    export function createCommentController(id: string): unknown;
  }
}
`

test("declaredApi reads runtime values, ambient namespaces included, and skips types", () => {
  const { topLevel, namespaces } = declaredApi(DECLARATIONS)
  assert.deepEqual([...topLevel].sort(), [
    "Position",
    "ViewColumn",
    "comments",
    "version",
    "window",
  ])
  assert.deepEqual([...namespaces.get("window")].sort(), [
    "activeTextEditor",
    "createTreeView",
    "onDidChangeActiveTextEditor",
    "showInformationMessage",
  ])
  assert.deepEqual([...namespaces.get("comments")], ["createCommentController"])
})

test("classify sorts each value into implemented, unsupported and missing", () => {
  const declared = declaredApi(DECLARATIONS)
  const shim = {
    version: "1.91.0",
    Position: class {},
    window: {
      showInformationMessage() {},
      onDidChangeActiveTextEditor() {},
      get activeTextEditor() {
        throw new Error("getters are not read")
      },
      registerExtra() {},
    },
    comments: { createCommentController() {} },
    NotSupportedError: Error,
  }
  const { report, errors } = classify(declared, shim, {
    comments: "Cognia's editor has no comment threads.",
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(report.implemented, [
    "Position",
    "version",
    "window.activeTextEditor",
    "window.onDidChangeActiveTextEditor",
    "window.showInformationMessage",
  ])
  assert.deepEqual(report.unsupported, {
    comments: "Cognia's editor has no comment threads.",
    "comments.createCommentController": "Cognia's editor has no comment threads.",
  })
  assert.deepEqual(report.missing, ["ViewColumn", "window.createTreeView"])
  assert.deepEqual(report.extra, ["NotSupportedError", "window.registerExtra"])
})

test("classify refuses unsupported entries for API that does not exist or is not mounted", () => {
  const declared = declaredApi(DECLARATIONS)
  const shim = { window: {}, comments: {} }
  const { errors } = classify(declared, shim, {
    "window.madeUp": "no",
    "window.createTreeView": "Cognia shows no tree views.",
  })
  assert.deepEqual(errors, [
    'unsupported.ts names "window.madeUp", which vscode.d.ts does not declare',
    'unsupported.ts names "window.createTreeView", which the shim does not mount: an extension would get undefined, not the reason',
  ])
})

test("a namespace the shim does not mount leaves all its members missing", () => {
  const { report } = classify(declaredApi(DECLARATIONS), { window: {} }, {})
  assert.ok(report.missing.includes("comments.createCommentController"))
})

test("inertDependencies answers anything with something callable", () => {
  const deps = inertDependencies()
  assert.equal(deps.extensionId, "cognia.api-coverage")
  assert.equal(typeof deps.connection.onRequest, "function")
  assert.equal(typeof deps.connection.onRequest("x", () => {}).dispose, "function")
  assert.equal(deps.then, undefined)
})
