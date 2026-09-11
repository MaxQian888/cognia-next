import {
  BASHES_COMMANDS,
  bashRunLabel,
  bashesActionsHandler,
  bashesForegroundHandler,
  bashesKillHandler,
  bashesListHandler,
  bashesViewHandler,
  buildBashesItems,
  runningBashCells,
} from "./bashes-command"
import type { BashCell, Cell } from "../state/types"
import type { CommandContext } from "./types"

const bash = (id: string, command: string, over: Partial<BashCell> = {}): BashCell => ({
  id,
  kind: "bash",
  command,
  output: "",
  status: "running",
  ...over,
})

function ctx(cells: Cell[], args = ""): CommandContext {
  return { args, state: { cells }, config: {}, version: "0" } as unknown as CommandContext
}

describe("bashesListHandler", () => {
  it("notices when nothing is running", () => {
    const done = bash("bash-1", "ls", { status: "done" })
    const effect = bashesListHandler(ctx([done]))
    expect(effect.kind).toBe("notice")
    if (effect.kind === "notice") expect(effect.message).toContain("!<command>")
  })

  it("opens a picker of every live run routed to /bashes actions", () => {
    const cells = [
      bash("bash-1", "pnpm dev", { background: true }),
      bash("bash-2", "tail -f log"),
      bash("bash-3", "old", { status: "error" }),
    ]
    const effect = bashesListHandler(ctx(cells))
    if (effect.kind !== "openOverlay" || effect.overlay.kind !== "select") {
      throw new Error("expected select overlay")
    }
    expect(effect.overlay.title).toBe("Running commands (2)")
    expect(effect.overlay.onSelectCommand).toBe("bashes actions")
    expect(effect.overlay.items).toEqual([
      { id: "bash-1", label: "⧗ pnpm dev", hint: "background" },
      { id: "bash-2", label: "⏵ tail -f log", hint: "foreground · Ctrl+C kills" },
    ])
  })
})

describe("bashesActionsHandler", () => {
  it("offers view/kill for a foreground run and adds fg for a backgrounded one", () => {
    const fgEffect = bashesActionsHandler(ctx([bash("bash-1", "dev")], "bash-1"))
    if (fgEffect.kind !== "openOverlay" || fgEffect.overlay.kind !== "select") {
      throw new Error("expected select overlay")
    }
    expect(fgEffect.overlay.items.map((i) => i.id)).toEqual(["view bash-1", "kill bash-1"])

    const bgEffect = bashesActionsHandler(
      ctx([bash("bash-1", "dev", { background: true })], "bash-1")
    )
    if (bgEffect.kind !== "openOverlay" || bgEffect.overlay.kind !== "select") {
      throw new Error("expected select overlay")
    }
    expect(bgEffect.overlay.items.map((i) => i.id)).toEqual([
      "view bash-1",
      "kill bash-1",
      "fg bash-1",
    ])
    expect(bgEffect.overlay.onSelectCommand).toBe("bashes")
  })

  it("falls back to the output view when the run settled meanwhile", () => {
    const effect = bashesActionsHandler(
      ctx([bash("bash-1", "ls", { status: "done", output: "files" })], "bash-1")
    )
    expect(effect.kind).toBe("openOverlay")
    if (effect.kind === "openOverlay") expect(effect.overlay.kind).toBe("document")
  })

  it("notices on a missing/unknown id", () => {
    expect(bashesActionsHandler(ctx([], "")).kind).toBe("notice")
    expect(bashesActionsHandler(ctx([], "nope")).kind).toBe("notice")
  })
})

describe("bashesViewHandler", () => {
  it("opens the run's output in the pager with a status note", () => {
    const effect = bashesViewHandler(
      ctx(
        [bash("bash-1", "pnpm dev", { background: true, output: "listening on :3000" })],
        "bash-1"
      )
    )
    if (effect.kind !== "openOverlay" || effect.overlay.kind !== "document") {
      throw new Error("expected document overlay")
    }
    expect(effect.overlay.title).toContain("pnpm dev")
    expect(effect.overlay.title).toContain("background")
    expect(effect.overlay.body).toBe("listening on :3000")
    expect(effect.overlay.format).toBe("text")
  })

  it("shows exit detail for a settled run and a placeholder for empty output", () => {
    const effect = bashesViewHandler(
      ctx([bash("bash-1", "false", { status: "error", exitCode: 2 })], "bash-1")
    )
    if (effect.kind !== "openOverlay" || effect.overlay.kind !== "document") {
      throw new Error("expected document overlay")
    }
    expect(effect.overlay.title).toContain("exit 2")
    expect(effect.overlay.body).toBe("(no output yet)")
  })

  it("notices on a missing id", () => {
    expect(bashesViewHandler(ctx([], "")).kind).toBe("notice")
  })
})

describe("kill / fg handlers", () => {
  it("emit the matching effects with the id", () => {
    expect(bashesKillHandler(ctx([], "bash-2"))).toEqual({ kind: "bashKill", id: "bash-2" })
    expect(bashesForegroundHandler(ctx([], "bash-2"))).toEqual({
      kind: "bashForeground",
      id: "bash-2",
    })
  })

  it("notice usage when the id is missing", () => {
    expect(bashesKillHandler(ctx([], "")).kind).toBe("notice")
    expect(bashesForegroundHandler(ctx([], "")).kind).toBe("notice")
  })
})

describe("helpers + descriptor", () => {
  it("bashRunLabel collapses whitespace and truncates long commands", () => {
    expect(bashRunLabel(bash("b", "echo   hi\n there"))).toBe("echo hi there")
    const long = bash("b", "x".repeat(80))
    expect(bashRunLabel(long).length).toBe(60)
    expect(bashRunLabel(long).endsWith("…")).toBe(true)
  })

  it("runningBashCells filters to live bash cells only", () => {
    const cells: Cell[] = [
      bash("bash-1", "a"),
      bash("bash-2", "b", { status: "done" }),
      { id: "u1", kind: "user", text: "hi" } as never,
    ]
    expect(runningBashCells(ctx(cells)).map((c) => c.id)).toEqual(["bash-1"])
  })

  it("buildBashesItems marks foreground vs background", () => {
    const items = buildBashesItems([bash("bash-1", "a"), bash("bash-2", "b", { background: true })])
    expect(items[0].label.startsWith("⏵")).toBe(true)
    expect(items[1].label.startsWith("⧗")).toBe(true)
  })

  it("registers /bashes with the jobs alias and all four verbs", () => {
    expect(BASHES_COMMANDS).toHaveLength(1)
    const cmd = BASHES_COMMANDS[0]
    expect(cmd.name).toBe("bashes")
    expect(cmd.aliases).toContain("jobs")
    expect(cmd.subcommands?.map((s) => s.name)).toEqual([
      "history",
      "actions",
      "view",
      "kill",
      "fg",
    ])
  })
})

it("offers targets when view/kill/fg are invoked without an ID", () => {
  const cells = [
    bash("live", "dev"),
    bash("bg", "watch", { background: true }),
    bash("done", "ls", { status: "done" }),
  ]
  for (const [handler, ids, command] of [
    [bashesViewHandler, ["live", "bg", "done"], "bashes view"],
    [bashesKillHandler, ["live", "bg"], "bashes kill"],
    [bashesForegroundHandler, ["bg"], "bashes fg"],
  ] as const) {
    const effect = handler(ctx(cells))
    expect(effect).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "select", onSelectCommand: command },
    })
    if (effect.kind === "openOverlay" && effect.overlay.kind === "select")
      expect(effect.overlay.items.map((i) => i.id)).toEqual(ids)
  }
})

it("exposes finished command history and tracks output by cell ID", () => {
  const cell = bash("done", "ls", { status: "done", exitCode: 0 })
  const history = BASHES_COMMANDS[0].subcommands?.find((s) => s.name === "history")
  expect(history?.handler?.(ctx([cell]))).toMatchObject({
    kind: "openOverlay",
    overlay: { onSelectCommand: "bashes view" },
  })
  expect(bashesViewHandler(ctx([cell], "done"))).toMatchObject({
    overlay: { sourceBashId: "done" },
  })
})

it("localizes job action menus", () => {
  const context = ctx([bash("live", "dev", { background: true })], "live")
  context.config.locale = "zh-CN"
  const result = bashesActionsHandler(context)
  expect(JSON.stringify(result)).toContain("查看输出")
  expect(JSON.stringify(result)).toContain("终止")
})

it("routes job alias picker choices back to the intended action", async () => {
  const { registerCommands } = await import("./registry")
  const { dispatchCommand } = await import("./dispatch")
  registerCommands(BASHES_COMMANDS)
  const context = ctx([bash("bg", "dev", { background: true })])
  const picker = dispatchCommand("/jobs fg", context)
  if (picker.kind !== "openOverlay" || picker.overlay.kind !== "select")
    throw new Error("expected target picker")
  expect(
    dispatchCommand(`/${picker.overlay.onSelectCommand} ${picker.overlay.items[0].id}`, context)
  ).toEqual({ kind: "bashForeground", id: "bg" })
})
