// The value types of `value-types.ts`: constructors, defaults and validation
// as `vscode.d.ts` and VS Code's implementation define them.
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  Breakpoint,
  BranchCoverage,
  DataTransfer,
  DataTransferItem,
  DeclarationCoverage,
  FileCoverage,
  FunctionBreakpoint,
  NotebookCellData,
  NotebookCellOutputItem,
  NotebookEdit,
  NotebookRange,
  ProcessExecution,
  ShellExecution,
  SourceBreakpoint,
  StatementCoverage,
  Task,
  TaskGroup,
  TerminalLink,
  TestCoverageCount,
  TestMessage,
  TestRunRequest,
  ChatResponseMarkdownPart,
} from "../dist/vscode-shim/value-types.js"
import { Location, TaskScope } from "../dist/vscode-shim/api-types.js"
import { MarkdownString, Position, Uri } from "../dist/vscode-shim/types.js"

test("Task takes both constructor forms and normalises its problem matchers", () => {
  const execution = new ShellExecution("make")
  const scoped = new Task({ type: "make" }, TaskScope.Workspace, "build", "make", execution, "$gcc")
  assert.equal(scoped.scope, TaskScope.Workspace)
  assert.equal(scoped.name, "build")
  assert.equal(scoped.source, "make")
  assert.equal(scoped.execution, execution)
  assert.deepEqual(scoped.problemMatchers, ["$gcc"])
  assert.equal(scoped.hasDefinedMatchers, true)
  assert.equal(scoped.isBackground, false)
  assert.deepEqual(scoped.presentationOptions, {})

  const legacy = new Task({ type: "npm" }, "test", "npm", execution)
  assert.equal(legacy.scope, undefined)
  assert.equal(legacy.name, "test")
  assert.equal(legacy.source, "npm")
  assert.deepEqual(legacy.problemMatchers, [])
  assert.equal(legacy.hasDefinedMatchers, false)

  assert.throws(
    () => new Task({ type: "x" }, TaskScope.Global, "name", ""),
    /source must be a string/
  )
})

test("TaskGroup has VS Code's built-in groups", () => {
  assert.deepEqual(
    [TaskGroup.Clean, TaskGroup.Build, TaskGroup.Rebuild, TaskGroup.Test].map((group) => group.id),
    ["clean", "build", "rebuild", "test"]
  )
  assert.equal(TaskGroup.Build.label, "Build")
})

test("ProcessExecution and ShellExecution read their arguments as VS Code does", () => {
  const withArgs = new ProcessExecution("node", ["-v"], { cwd: "/tmp" })
  assert.deepEqual(
    [withArgs.process, withArgs.args, withArgs.options],
    ["node", ["-v"], { cwd: "/tmp" }]
  )
  const withOptions = new ProcessExecution("node", { cwd: "/tmp" })
  assert.deepEqual([withOptions.args, withOptions.options], [[], { cwd: "/tmp" }])
  assert.throws(() => new ProcessExecution(undefined), /process/)

  const line = new ShellExecution("echo hi", { cwd: "/tmp" })
  assert.deepEqual([line.commandLine, line.command, line.args], ["echo hi", undefined, []])
  const split = new ShellExecution("echo", ["hi"])
  assert.deepEqual([split.commandLine, split.command, split.args], [undefined, "echo", ["hi"]])
  assert.throws(() => new ShellExecution(undefined, []), /command can't be undefined/)
})

test("TerminalLink validates its offsets", () => {
  assert.equal(new TerminalLink(1, 4, "open").tooltip, "open")
  assert.throws(() => new TerminalLink("1", 4), TypeError)
})

test("DataTransfer matches mime types case-insensitively and iterates in insertion order", async () => {
  const transfer = new DataTransfer()
  transfer.set("Text/Plain", new DataTransferItem("hello"))
  transfer.set("application/json", new DataTransferItem({ a: 1 }))
  assert.equal(await transfer.get("text/plain").asString(), "hello")
  assert.equal(await transfer.get("APPLICATION/JSON").asString(), '{"a":1}')
  assert.equal(transfer.get("text/plain").asFile(), undefined)
  assert.deepEqual(
    [...transfer].map(([mime]) => mime),
    ["text/plain", "application/json"]
  )
  const seen = []
  transfer.forEach((_item, mime, owner) => seen.push([mime, owner === transfer]))
  assert.deepEqual(seen, [
    ["text/plain", true],
    ["application/json", true],
  ])
})

test("NotebookRange orders its ends, rejects bad ones and reuses itself when unchanged", () => {
  const range = new NotebookRange(4, 2)
  assert.deepEqual([range.start, range.end, range.isEmpty], [2, 4, false])
  assert.equal(range.with({}), range)
  assert.deepEqual(range.with({ end: 2 }).isEmpty, true)
  assert.throws(() => new NotebookRange(-1, 2), /positive integer/)
  assert.throws(() => new NotebookRange(1.5, 2), /positive integer/)
})

test("NotebookCellOutputItem encodes text, JSON and errors under VS Code's mime types", () => {
  const decode = (item) => new TextDecoder().decode(item.data)
  assert.deepEqual(
    [decode(NotebookCellOutputItem.text("hi")), NotebookCellOutputItem.text("hi").mime],
    ["hi", "text/plain"]
  )
  assert.equal(decode(NotebookCellOutputItem.json({ a: 1 })), '{\n\t"a": 1\n}')
  assert.equal(NotebookCellOutputItem.json({}).mime, "text/x-json")
  assert.equal(NotebookCellOutputItem.stdout("o").mime, "application/vnd.code.notebook.stdout")
  assert.equal(NotebookCellOutputItem.stderr("e").mime, "application/vnd.code.notebook.stderr")
  const error = NotebookCellOutputItem.error(new TypeError("bad"))
  assert.equal(error.mime, "application/vnd.code.notebook.error")
  assert.deepEqual(
    { ...JSON.parse(decode(error)), stack: undefined },
    { name: "TypeError", message: "bad", stack: undefined }
  )
})

test("NotebookEdit's factories build the edits VS Code builds", () => {
  const cell = new NotebookCellData(2, "print(1)", "python")
  const insert = NotebookEdit.insertCells(3, [cell])
  assert.deepEqual([insert.range.start, insert.range.end, insert.newCells], [3, 3, [cell]])
  assert.deepEqual(NotebookEdit.deleteCells(new NotebookRange(0, 2)).newCells, [])
  assert.deepEqual(NotebookEdit.updateCellMetadata(1, { a: 1 }).newCellMetadata, { a: 1 })
  const notebook = NotebookEdit.updateNotebookMetadata({ b: 2 })
  assert.deepEqual([notebook.range.start, notebook.newNotebookMetadata], [0, { b: 2 }])
})

test("breakpoints default to enabled and get a stable id", () => {
  const location = new Location(Uri.file("/a.ts"), new Position(1, 0))
  const source = new SourceBreakpoint(location, undefined, "x > 1")
  assert.equal(source.enabled, true)
  assert.equal(source.condition, "x > 1")
  assert.equal(source.id, source.id)
  assert.match(source.id, /^[0-9a-f-]{36}$/)
  assert.ok(source instanceof Breakpoint)
  assert.equal(new FunctionBreakpoint("main", false).enabled, false)
  assert.throws(() => new SourceBreakpoint(null), /location/)
})

test("TestRunRequest defaults, TestMessage.diff and the markdown chat part", () => {
  const request = new TestRunRequest()
  assert.deepEqual(
    [request.include, request.continuous, request.preserveFocus],
    [undefined, false, true]
  )
  const diff = TestMessage.diff("mismatch", "1", "2")
  assert.deepEqual([diff.message, diff.expectedOutput, diff.actualOutput], ["mismatch", "1", "2"])
  const part = new ChatResponseMarkdownPart("**hi**")
  assert.ok(part.value instanceof MarkdownString)
  assert.equal(part.value.value, "**hi**")
})

test("FileCoverage.fromDetails counts statements, branches and declarations", () => {
  const at = new Position(0, 0)
  const coverage = FileCoverage.fromDetails(Uri.file("/a.ts"), [
    new StatementCoverage(1, at, [new BranchCoverage(true), new BranchCoverage(0)]),
    new StatementCoverage(false, at),
    new DeclarationCoverage("main", 3, at),
  ])
  assert.deepEqual(
    [coverage.statementCoverage, coverage.branchCoverage, coverage.declarationCoverage].map(
      (count) => [count.covered, count.total]
    ),
    [
      [1, 2],
      [1, 2],
      [1, 1],
    ]
  )
  const statementsOnly = FileCoverage.fromDetails(Uri.file("/b.ts"), [new StatementCoverage(0, at)])
  assert.equal(statementsOnly.branchCoverage, undefined)
  assert.equal(statementsOnly.declarationCoverage, undefined)
  assert.throws(() => new TestCoverageCount(3, 2), /cannot be greater than the total/)
})
