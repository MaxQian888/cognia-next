// The pieces of `vscode.tasks` that need no host: quoting, variables, the
// terminal a task runs in, and the wire form tasks cross the renderer in.
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  fromWireTask,
  quoteShellArg,
  shellCommandArgs,
  substituteTaskVariables,
  taskTerminalOptions,
  toWireTask,
} from "../dist/vscode-shim/tasks.js"
import { TaskRevealKind, TaskScope } from "../dist/vscode-shim/api-types.js"
import {
  CustomExecution,
  ProcessExecution,
  ShellExecution,
  ShellQuoting,
  Task,
  TaskGroup,
} from "../dist/vscode-shim/value-types.js"
import { Uri } from "../dist/vscode-shim/types.js"

const folder = { uri: Uri.file("/work/app"), name: "app", index: 0 }

test("each shell family gets its own way to run one command line", () => {
  assert.deepEqual(shellCommandArgs("/bin/zsh"), ["-c"])
  assert.deepEqual(shellCommandArgs("C:\\Windows\\System32\\cmd.exe"), ["/d", "/c"])
  assert.deepEqual(shellCommandArgs("pwsh"), ["-Command"])
})

test("arguments are quoted for the shell as their quoting says", () => {
  assert.equal(quoteShellArg("plain", "/bin/sh"), "plain")
  assert.equal(quoteShellArg("two words", "/bin/sh"), "'two words'")
  assert.equal(quoteShellArg("it's", "/bin/sh"), `'it'\\''s'`)
  assert.equal(quoteShellArg("", "/bin/sh"), "''")
  assert.equal(
    quoteShellArg({ value: 'a "b" $c', quoting: ShellQuoting.Weak }, "/bin/sh"),
    '"a \\"b\\" \\$c"'
  )
  assert.equal(quoteShellArg({ value: "a b", quoting: ShellQuoting.Escape }, "/bin/sh"), "a\\ b")
  assert.equal(quoteShellArg("two words", "cmd.exe"), '"two words"')
  assert.equal(quoteShellArg({ value: "a&b", quoting: ShellQuoting.Escape }, "cmd.exe"), "a^&b")
  assert.equal(quoteShellArg("it's here", "pwsh"), "'it''s here'")
})

test("the task variables are substituted, others left as written", () => {
  const env = { HOME_DIR: "/h" }
  assert.equal(
    substituteTaskVariables(
      "${workspaceFolder}/out ${workspaceFolderBasename} ${env:HOME_DIR} ${env:NONE}|${file}",
      folder,
      env
    ),
    "/work/app/out app /h |${file}"
  )
  assert.equal(substituteTaskVariables("${workspaceFolder}", undefined, env), "${workspaceFolder}")
})

test("a shell execution runs its command line in the shell, in the workspace folder", () => {
  const task = new Task(
    { type: "x" },
    TaskScope.Workspace,
    "build",
    "x",
    new ShellExecution("make ${workspaceFolderBasename}")
  )
  assert.deepEqual(taskTerminalOptions(task, folder, "/bin/bash"), {
    name: "x: build",
    shellPath: "/bin/bash",
    shellArgs: ["-c", "make app"],
    cwd: "/work/app",
  })
})

test("a shell execution's own executable, shell arguments, cwd and env win", () => {
  const task = new Task(
    { type: "x" },
    TaskScope.Workspace,
    "test",
    "x",
    new ShellExecution("npm", ["test", "--", "a b"], {
      executable: "pwsh",
      cwd: "${workspaceFolder}/pkg",
      env: { CI: "1", BAD: 2 },
    })
  )
  task.presentationOptions = { reveal: TaskRevealKind.Never }
  assert.deepEqual(taskTerminalOptions(task, folder, "/bin/bash"), {
    name: "x: test",
    shellPath: "pwsh",
    shellArgs: ["-Command", "npm test -- 'a b'"],
    cwd: "/work/app/pkg",
    env: { CI: "1" },
    hideFromUser: true,
  })
})

test("a process execution runs without a shell", () => {
  const task = new Task(
    { type: "x" },
    TaskScope.Global,
    "lint",
    "x",
    new ProcessExecution("eslint", ["${workspaceFolder}"])
  )
  const options = taskTerminalOptions(task, folder, "/bin/bash")
  assert.equal(options.shellPath, "eslint")
  assert.deepEqual(options.shellArgs, ["/work/app"])
})

test("tasks cross the renderer and come back as Tasks", () => {
  const task = new Task(
    { type: "npm", script: "build" },
    folder,
    "build",
    "npm",
    new ShellExecution("npm", ["run", "build"]),
    "$tsc"
  )
  task.group = TaskGroup.Build
  task.detail = "tsc -p ."
  const wire = toWireTask(task, "acme.npm")
  assert.deepEqual(JSON.parse(JSON.stringify(wire)), {
    id: "acme.npm/npm/build",
    extensionId: "acme.npm",
    name: "build",
    source: "npm",
    definition: { type: "npm", script: "build" },
    detail: "tsc -p .",
    group: "build",
    isBackground: false,
    problemMatchers: ["$tsc"],
    scope: { folder: "file:///work/app" },
    execution: { kind: "shell", command: "npm", args: ["run", "build"] },
  })
  const back = fromWireTask(JSON.parse(JSON.stringify(wire)), [folder])
  assert.ok(back instanceof Task)
  assert.equal(back.scope, folder)
  assert.equal(back.group, TaskGroup.Build)
  assert.ok(back.execution instanceof ShellExecution)
  assert.deepEqual([back.execution.command, back.execution.args], ["npm", ["run", "build"]])
})

test("another extension's custom task refuses to run here", async () => {
  const task = new Task(
    { type: "c" },
    TaskScope.Workspace,
    "watch",
    "c",
    new CustomExecution(async () => ({}))
  )
  const back = fromWireTask(JSON.parse(JSON.stringify(toWireTask(task, "acme.other"))), [])
  assert.ok(back.execution instanceof CustomExecution)
  await assert.rejects(back.execution.callback({}), /only that extension can run it/)
})
