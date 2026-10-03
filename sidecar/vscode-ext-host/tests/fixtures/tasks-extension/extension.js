// Provides, fetches and runs tasks the ways extensions do; each command
// returns what the extension saw.
const vscode = require("vscode")

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const events = []
  const record =
    (kind, extra = () => ({})) =>
    (event) =>
      events.push({ kind, task: event.execution.task.name, ...extra(event) })
  context.subscriptions.push(
    vscode.tasks.onDidStartTask(record("start")),
    vscode.tasks.onDidStartTaskProcess(record("startProcess")),
    vscode.tasks.onDidEndTaskProcess(
      record("endProcess", (event) => ({ exitCode: event.exitCode }))
    ),
    vscode.tasks.onDidEndTask(record("end"))
  )

  const build = new vscode.Task(
    { type: "fixture", target: "build" },
    vscode.TaskScope.Workspace,
    "build",
    "fixture",
    new vscode.ShellExecution("make", ["all", "two words"], { cwd: "/tmp" })
  )
  build.group = vscode.TaskGroup.Build
  const unresolved = new vscode.Task(
    { type: "fixture", target: "lazy" },
    vscode.TaskScope.Workspace,
    "lazy",
    "fixture"
  )
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider("fixture", {
      provideTasks: () => [build],
      resolveTask: (task) => {
        task.execution = new vscode.ProcessExecution("node", ["-v"])
        return task
      },
    })
  )

  register("tasksFixture.fetch", async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: "fixture" })
    return tasks.map((task) => ({
      name: task.name,
      same: task === build,
      group: task.group && task.group.id,
      commandLine: task.execution && task.execution.command,
    }))
  })
  register("tasksFixture.run", async () => {
    const execution = await vscode.tasks.executeTask(build)
    return { running: vscode.tasks.taskExecutions.length, same: execution.task === build }
  })
  register("tasksFixture.runLazy", async () => {
    const execution = await vscode.tasks.executeTask(unresolved)
    return { process: execution.task.execution.process }
  })
  register("tasksFixture.custom", async () => {
    const write = new vscode.EventEmitter()
    const close = new vscode.EventEmitter()
    const task = new vscode.Task(
      { type: "fixture" },
      vscode.TaskScope.Workspace,
      "custom",
      "fixture",
      new vscode.CustomExecution(async () => ({
        onDidWrite: write.event,
        onDidClose: close.event,
        open: () => {
          write.fire("working\r\n")
          setTimeout(() => close.fire(3), 10)
        },
        close: () => {},
      }))
    )
    await vscode.tasks.executeTask(task)
    return true
  })
  register("tasksFixture.terminate", () => {
    for (const execution of vscode.tasks.taskExecutions) execution.terminate()
    return true
  })
  register("tasksFixture.events", () => ({ events, running: vscode.tasks.taskExecutions.length }))
}
