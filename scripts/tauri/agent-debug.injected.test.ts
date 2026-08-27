/** @jest-environment jsdom */

import fs from "node:fs"
import path from "node:path"

type AgentDebugApi = {
  version: number
  capabilities: Record<string, unknown>
  snapshot: (options?: {
    includeText?: boolean
    includeHidden?: boolean
    query?: { steps: unknown[] }
  }) => {
    generation: number
    nodes: Array<{ ref: string; role: string; name: string; value?: string; visible: boolean }>
  }
  act: (ref: string, action: string, args?: Record<string, unknown>) => Promise<unknown>
  inspect: (ref: string, operation: string, args?: Record<string, unknown>) => Promise<unknown>
  locator: (request: Record<string, unknown>) => Promise<{
    ok: boolean
    value?: unknown
    nodes?: Array<{ name: string }>
  }>
  installDialogHandler: (options?: Record<string, unknown>) => boolean
  getDialogs: () => Array<{ type: string; message: string }>
  drainConsole: () => unknown[]
  readConsole: (
    after?: number,
    limit?: number
  ) => {
    entries: Array<{ id: number; level: string; args: unknown[] }>
    nextCursor: number
    dropped: number
  }
}

const code = fs.readFileSync(
  path.join(__dirname, "../../src-tauri/src/agent_debug/injected.js"),
  "utf8"
)

const coreCode = fs.readFileSync(
  path.join(__dirname, "../../lib/browser/automation-core.injected.js"),
  "utf8"
)

function installAgentDebug() {
  ;(0, eval)(coreCode)
  ;(0, eval)(code)
}

test("exposes generation-scoped snapshots, actions, and buffered diagnostics", async () => {
  document.body.innerHTML = `
    <label for="query">Query</label>
    <input id="query" />
    <button type="button">Run</button>
    <p>Result text</p>
    <section hidden><button type="button">Hidden action</button></section>
  `
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      top: 20,
      right: 110,
      bottom: 50,
      left: 10,
    }),
  })
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
  })

  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const first = api.snapshot()
  expect(api.version).toBe(3)
  expect(api.capabilities).toEqual(
    expect.objectContaining({ locatorAutoWait: true, networkMocking: "fetch-only", video: false })
  )
  expect(first.generation).toBe(1)
  expect(first.nodes.map((node) => [node.role, node.name])).toEqual([
    ["textbox", "Query"],
    ["button", "Run"],
  ])

  const input = first.nodes[0]
  await api.act(input.ref, "fill", { value: "agent value" })
  expect((document.getElementById("query") as HTMLInputElement).value).toBe("agent value")
  expect(await api.inspect(input.ref, "getAttribute", { name: "id" })).toBe("query")
  expect(api.snapshot().generation).toBe(2)
  await expect(api.act(input.ref, "click")).rejects.toThrow("stale or unknown element ref")

  console.warn("agent diagnostic", { ok: true })
  expect(api.drainConsole()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ level: "warn", args: ["agent diagnostic", { ok: true }] }),
    ])
  )

  const nested = api.snapshot({
    includeHidden: true,
    query: {
      steps: [
        { kind: "css", selector: "section" },
        { kind: "role", role: "button", name: "Hidden action", exact: true, includeHidden: true },
      ],
    },
  })
  expect(nested.nodes).toEqual([expect.objectContaining({ name: "Hidden action", visible: false })])

  api.installDialogHandler({ defaultConfirm: false })
  expect(window.confirm("Continue?")).toBe(false)
  expect(api.getDialogs()).toEqual([
    expect.objectContaining({ type: "confirm", message: "Continue?" }),
  ])
})

test("deduplicates nested snapshot text but preserves independent repeated results", () => {
  document.body.innerHTML = `
    <ul><li><p>Same result</p></li></ul>
    <p>Repeated sibling</p>
    <p>Repeated sibling</p>
  `
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      top: 20,
      right: 110,
      bottom: 50,
      left: 10,
    }),
  })

  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const nodes = api.snapshot({ includeText: true }).nodes

  expect(nodes.filter((node) => node.name === "Same result")).toHaveLength(1)
  expect(nodes.filter((node) => node.name === "Repeated sibling")).toHaveLength(2)
})

test("resolves concurrent locator operations atomically and fires one action once", async () => {
  document.body.innerHTML = `
    <button id="first">First</button>
    <button id="second">Second</button>
  `
  const events: string[] = []
  document.getElementById("first")?.addEventListener("click", () => events.push("first"))
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug

  const [first, second] = await Promise.all([
    api.locator({
      query: { steps: [{ kind: "css", selector: "#first" }] },
      operation: "inspect",
      name: "textContent",
    }),
    api.locator({
      query: { steps: [{ kind: "css", selector: "#second" }] },
      operation: "inspect",
      name: "textContent",
    }),
  ])
  const action = await api.locator({
    query: { steps: [{ kind: "css", selector: "#first" }] },
    operation: "action",
    name: "click",
    requirements: {},
  })

  expect([first.value, second.value]).toEqual(["First", "Second"])
  expect(action.ok).toBe(true)
  expect(events).toEqual(["first"])
})

test("fills contenteditable elements and emits the native double-click sequence", async () => {
  document.body.innerHTML = `<div id="editable" contenteditable="true"></div><button>Run</button>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const eventTypes: string[] = []
  for (const type of ["mousedown", "mouseup", "click", "dblclick"])
    document.querySelector("button")?.addEventListener(type, () => eventTypes.push(type))

  await api.locator({
    query: { steps: [{ kind: "css", selector: "#editable" }] },
    operation: "action",
    name: "fill",
    args: { value: "editable value" },
    requirements: { editable: true },
  })
  await api.locator({
    query: { steps: [{ kind: "role", role: "button", name: "Run" }] },
    operation: "action",
    name: "dblclick",
    requirements: {},
  })

  expect(document.getElementById("editable")?.textContent).toBe("editable value")
  expect(eventTypes).toEqual([
    "mousedown",
    "mouseup",
    "click",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
  ])
})

test("queries open shadow roots and same-origin frames in stable scope order", async () => {
  document.body.innerHTML = `<button>Outer</button><div id="host"></div><iframe></iframe>`
  const host = document.getElementById("host")!
  host.attachShadow({ mode: "open" }).innerHTML = `<button>Shadow</button>`
  const frame = document.querySelector("iframe")!
  frame.contentDocument!.body.innerHTML = `<button>Frame</button>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug

  const result = await api.locator({
    query: { steps: [{ kind: "css", selector: "button" }] },
    operation: "query",
    strict: false,
  })

  expect(result.nodes?.map((node) => node.name)).toEqual(["Outer", "Shadow", "Frame"])
})

test("diagnostic cursors are independent and reinjection does not stack handlers", () => {
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const start = api.readConsole().nextCursor

  installAgentDebug()
  console.info("cursor diagnostic")

  const firstConsumer = api.readConsole(start)
  const secondConsumer = api.readConsole(start)
  expect(firstConsumer.entries).toEqual(secondConsumer.entries)
  expect(firstConsumer.entries).toEqual([
    expect.objectContaining({ id: start + 1, level: "info", args: ["cursor diagnostic"] }),
  ])
  expect(api.readConsole(firstConsumer.nextCursor).entries).toEqual([])
})

test("actionability blocks obscured targets while trial and force never double-fire", async () => {
  document.body.innerHTML = `<button id="target">Target</button><div id="cover"></div>`
  const target = document.getElementById("target")!
  const cover = document.getElementById("cover")!
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => cover,
  })
  const clicks: string[] = []
  target.addEventListener("click", () => clicks.push("click"))
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const request = {
    query: { steps: [{ kind: "css", selector: "#target" }] },
    operation: "action",
    name: "click",
    requirements: { receivesEvents: true },
  }

  await expect(api.locator(request)).resolves.toMatchObject({
    ok: false,
    code: "not_receives_events",
  })
  await expect(
    api.locator({ ...request, options: { force: true, trial: true } })
  ).resolves.toMatchObject({ ok: true })
  expect(clicks).toEqual([])
  await api.locator({ ...request, options: { force: true } })
  expect(clicks).toEqual(["click"])
})

test("keyboard type appends through the shared native value primitive", async () => {
  document.body.innerHTML = `<input value="before" />`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const input = document.querySelector("input")!
  input.focus()

  await (
    api as unknown as { keyboard: (operation: string, args: unknown) => Promise<boolean> }
  ).keyboard("type", { text: " after" })

  expect(input.value).toBe("before after")
})

test("upgrades a legacy helper without stacking global instrumentation", () => {
  const previousApi = (window as unknown as { __cogniaAgentDebug: AgentDebugApi })
    .__cogniaAgentDebug
  const consoleIdentity = console.info
  const fetchIdentity = window.fetch
  const legacyConsole = [
    { timestamp: new Date().toISOString(), level: "info", args: ["legacy diagnostic"] },
  ]
  const legacyApi = {
    version: 2,
    drainConsole: () => legacyConsole.splice(0),
    drainNetwork: () => [],
    health: () => ({ pendingRequests: 2 }),
    getDialogs: () => [],
    clearDialogs: () => true,
    addNetworkRoute: () => true,
    removeNetworkRoute: () => true,
    clearNetworkRoutes: () => true,
    getNetworkRequests: () => [],
    clearNetworkRequests: () => true,
    installDialogHandler: () => true,
  }

  try {
    ;(window as unknown as { __cogniaAgentDebug: unknown }).__cogniaAgentDebug = legacyApi
    ;(0, eval)(code)
    const upgraded = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug

    expect(upgraded.version).toBe(3)
    expect(console.info).toBe(consoleIdentity)
    expect(window.fetch).toBe(fetchIdentity)
    expect(upgraded.readConsole(0).entries).toEqual([
      expect.objectContaining({ id: 1, level: "info", args: ["legacy diagnostic"] }),
    ])
    expect(upgraded.readConsole(0).entries).toHaveLength(1)
  } finally {
    ;(window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug = previousApi
  }
})

test("reports action-triggered SPA navigation metadata", async () => {
  document.body.innerHTML = `<button id="navigate">Navigate</button>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  document.getElementById("navigate")?.addEventListener("click", () => {
    history.pushState({}, "", "/agent-debug-after")
  })

  const result = await api.locator({
    query: { steps: [{ kind: "css", selector: "#navigate" }] },
    operation: "action",
    name: "click",
    requirements: {},
  })

  expect(result).toEqual(expect.objectContaining({ ok: true, navigation: true }))
})

test("returns an explicit unsupported error for inaccessible frame scope", async () => {
  document.body.innerHTML = `<iframe></iframe>`
  const frame = document.querySelector("iframe")!
  Object.defineProperty(frame, "contentDocument", {
    configurable: true,
    get: () => {
      throw new DOMException("Blocked a frame", "SecurityError")
    },
  })
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug

  await expect(
    api.locator({
      query: { steps: [{ kind: "css", selector: "#inside-cross-origin-frame" }] },
      operation: "inspect",
      name: "textContent",
    })
  ).resolves.toEqual(
    expect.objectContaining({
      ok: false,
      code: "unsupported_scope",
      error: expect.stringContaining("remote-Chromium"),
    })
  )
})
