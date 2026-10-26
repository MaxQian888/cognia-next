/** @jest-environment jsdom */

import fs from "node:fs"
import path from "node:path"

type AgentDebugApi = {
  version: number
  revision: number
  capabilities: Record<string, unknown>
  health: () => { heldInput: number; revision: number }
  helper: (
    method: string,
    args: unknown[],
    control?: { cancelled: boolean; guard?: () => void }
  ) => Promise<unknown>
  snapshot: (options?: {
    includeText?: boolean
    includeHidden?: boolean
    clientSessionId?: string
    query?: { steps: unknown[] }
  }) => {
    generation: number
    nodes: Array<{ ref: string; role: string; name: string; value?: string; visible: boolean }>
  }
  act: (ref: string, action: string, args?: Record<string, unknown>) => Promise<unknown>
  inspect: (
    ref: string,
    operation: string,
    args?: Record<string, unknown>,
    clientSessionId?: string
  ) => Promise<unknown>
  locator: (
    request: Record<string, unknown>,
    control?: { cancelled: boolean }
  ) => Promise<{
    ok: boolean
    code?: string
    retryable?: boolean
    dispatchState?: string
    value?: unknown
    nodes?: Array<{ name: string }>
  }>
  installDialogHandler: (options?: Record<string, unknown>) => boolean
  getDialogs: () => Array<{ type: string; message: string }>
  drainConsole: () => unknown[]
  readConsole: (
    after?: number,
    limit?: number,
    documentId?: string
  ) => {
    documentId: string
    cursorReset: boolean
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

let productionCore: object | undefined

function installAgentDebug() {
  ;(0, eval)(coreCode)
  const host = window as unknown as { __cogniaAutomationCore: Record<string, unknown> }
  if (Object.isFrozen(host.__cogniaAutomationCore)) {
    productionCore = host.__cogniaAutomationCore
    // A test-local facade lets cancellation tests suspend helpers. The real
    // injected core remains frozen; production bytes and assertions stay intact.
    host.__cogniaAutomationCore = { ...host.__cogniaAutomationCore }
  }
  ;(0, eval)(code)
}

test("keeps the production core immutable while injecting a controllable test facade", () => {
  installAgentDebug()
  expect(Object.isFrozen(productionCore)).toBe(true)
  expect(Object.getOwnPropertyDescriptor(productionCore, "isStable")).toMatchObject({
    writable: false,
    configurable: false,
  })
})

test("reports the installed helper revision in health", () => {
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  expect(api.health().revision).toBe(api.revision)
  expect(api.health().revision).toBe(7)
})

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

test("atomic delayed input stops between characters and chord cleanup releases modifiers", async () => {
  document.body.innerHTML = '<input aria-label="Message">'
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const input = document.querySelector("input")!
  input.focus()
  const control = { cancelled: false }
  input.addEventListener(
    "input",
    () => {
      control.cancelled = true
    },
    { once: true }
  )
  await expect(api.helper("keyboard", ["type", { text: "aa", delay: 5 }], control)).rejects.toThrow(
    /cancelled/
  )
  await new Promise((resolve) => setTimeout(resolve, 15))
  expect(input.value).toBe("a")
  const keys: Array<[string, boolean]> = []
  input.addEventListener("keydown", (event) => keys.push([event.key, event.ctrlKey]))
  await api.helper("keyboard", ["chord", { key: "Control+a" }], { cancelled: false })
  expect(keys).toContainEqual(["a", true])
  expect(api.health().heldInput).toBe(0)
  const cancelledChord = { cancelled: false }
  input.addEventListener(
    "keydown",
    () => {
      cancelledChord.cancelled = true
    },
    { once: true }
  )
  await expect(
    api.helper("keyboard", ["chord", { key: "Control+b" }], cancelledChord)
  ).rejects.toThrow(/cancelled/)
  expect(api.health().heldInput).toBe(0)
})

test("one locator input appends every delayed character within its cancellation fence", async () => {
  document.body.innerHTML = '<input aria-label="Message">'
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const input = document.querySelector("input")!
  const values: string[] = []
  input.addEventListener("input", () => values.push(input.value))
  const result = await api.locator(
    {
      query: { steps: [{ kind: "css", selector: "input" }] },
      operation: "action",
      name: "type",
      args: { value: "ab", delay: 2 },
      options: { force: true, scroll: "none" },
    },
    { cancelled: false }
  )
  expect(result.ok).toBe(true)
  expect(values).toEqual(["a", "ab"])
})

test("locator cancellation interrupts a delayed input before the next character", async () => {
  document.body.innerHTML = '<input aria-label="Message">'
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const input = document.querySelector("input")!
  const first = new Promise<void>((resolve) =>
    input.addEventListener("input", () => resolve(), { once: true })
  )
  const pending = api.locator(
    {
      query: { steps: [{ kind: "css", selector: "input" }] },
      operation: "action",
      name: "type",
      args: { value: "ab", delay: 1000 },
      requestId: "delayed-cancel",
      options: { force: true, scroll: "none" },
    },
    { cancelled: false }
  )
  await first
  await api.locator({ operation: "cancel", requestId: "delayed-cancel" })
  const result = await pending
  expect(result.ok).toBe(false)
  expect(result.dispatchState).toBe("dispatched")
  expect(input.value).toBe("a")
})

test("delayed input reports partial dispatch if the target is replaced", async () => {
  document.body.innerHTML = '<input aria-label="Message">'
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const input = document.querySelector("input")!
  input.addEventListener("input", () => input.replaceWith(input.cloneNode(true)), { once: true })
  const result = await api.locator(
    {
      query: { steps: [{ kind: "css", selector: "input" }] },
      operation: "action",
      name: "type",
      args: { value: "ab", delay: 2 },
      options: { force: true, scroll: "none" },
    },
    { cancelled: false }
  )
  expect(result.ok).toBe(false)
  expect(result.dispatchState).toBe("dispatched")
  expect(document.querySelector("input")!.value).toBe("a")
  expect(input.value).toBe("a")
})

test("revoked sessions cannot recreate refs with a late queued snapshot", () => {
  document.body.innerHTML = "<button>Count</button>"
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  api.snapshot({ clientSessionId: "revoked", includeHidden: true })
  ;(api as unknown as { releaseSession(id: string): void }).releaseSession("revoked")
  expect(() => api.snapshot({ clientSessionId: "revoked" })).toThrow(/revoked/)
  expect(api.snapshot({ clientSessionId: "fresh", includeHidden: true }).nodes).toHaveLength(1)
})

test("session snapshots do not invalidate or expose another session's refs", async () => {
  document.body.innerHTML = "<button>Run</button>"
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const first = api.snapshot({ clientSessionId: "agent-a", includeHidden: true })
  const second = api.snapshot({ clientSessionId: "agent-b", includeHidden: true })
  await expect(api.inspect(first.nodes[0].ref, "textContent", {}, "agent-a")).resolves.toBe("Run")
  await expect(api.inspect(first.nodes[0].ref, "textContent", {}, "agent-b")).rejects.toThrow(
    "stale or unknown"
  )
  api.snapshot({ clientSessionId: "agent-a", includeHidden: true })
  await expect(api.inspect(first.nodes[0].ref, "textContent", {}, "agent-a")).rejects.toThrow(
    "stale or unknown"
  )
  await expect(api.inspect(second.nodes[0].ref, "textContent", {}, "agent-b")).resolves.toBe("Run")
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

test("a cursor from an earlier document starts at the retained beginning", () => {
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const initial = api.readConsole()
  const reset = api.readConsole(initial.nextCursor + 100, 500, "previous-document")

  expect(reset.cursorReset).toBe(true)
  expect(reset.documentId).toBe(initial.documentId)
  expect(reset.entries).toEqual(initial.entries)
  expect(api.readConsole(reset.nextCursor, 500, reset.documentId)).toMatchObject({
    entries: [],
    cursorReset: false,
    documentId: reset.documentId,
  })
})

test("nested locator queries apply parent filtering and indexing before descendants", async () => {
  document.body.innerHTML = `
    <section><h2>Account</h2><button>First</button></section>
    <section><h2>Account</h2><button>Second</button></section>
    <section><h2>Other</h2><button>Third</button></section>
  `
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const query = {
    kind: "chain",
    root: {
      kind: "filtered",
      query: { steps: [{ kind: "css", selector: "section" }] },
      filters: [{ kind: "hasText", value: "Account" }],
      index: 1,
    },
    step: { kind: "role", role: "button" },
  }

  await expect(
    api.locator({ query, operation: "inspect", name: "textContent" })
  ).resolves.toMatchObject({ ok: true, value: "Second" })
  await expect(
    api.locator({
      query: { ...query, root: { ...query.root, index: -1 } },
      operation: "inspect",
      name: "textContent",
    })
  ).resolves.toMatchObject({ ok: true, value: "Second" })
})

test("fills a same-origin iframe textarea through the locator action", async () => {
  document.body.innerHTML = "<iframe></iframe>"
  const frame = document.querySelector("iframe")!
  frame.contentDocument!.body.innerHTML = '<textarea id="frame-text"></textarea>'
  const textarea = frame.contentDocument!.querySelector("textarea")!
  const inputs: Event[] = []
  textarea.addEventListener("input", (event) => inputs.push(event))
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug

  await expect(
    api.locator({
      query: { steps: [{ kind: "css", selector: "#frame-text" }] },
      operation: "action",
      name: "fill",
      args: { value: "Frame content" },
      requirements: { editable: true },
    })
  ).resolves.toMatchObject({ ok: true })
  expect(textarea.value).toBe("Frame content")
  expect(inputs).toHaveLength(1)
})

test("clicks a shadow-root button after descending the document hit target", async () => {
  document.body.innerHTML = '<div id="shadow-host"></div>'
  const host = document.getElementById("shadow-host")!
  const root = host.attachShadow({ mode: "open" })
  root.innerHTML = '<button id="shadow-target">Save</button>'
  const button = root.querySelector("button")!
  Object.defineProperty(button, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 10, height: 10 }),
  })
  const previousHitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => host,
  })
  Object.defineProperty(root, "elementFromPoint", {
    configurable: true,
    value: () => button,
  })
  const onClick = jest.fn()
  button.addEventListener("click", onClick)
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug

  try {
    await expect(
      api.locator({
        query: { steps: [{ kind: "css", selector: "#shadow-target" }] },
        operation: "action",
        name: "click",
        requirements: { visible: true, receivesEvents: true },
      })
    ).resolves.toMatchObject({ ok: true })
    expect(onClick).toHaveBeenCalledTimes(1)
  } finally {
    if (previousHitTest) Object.defineProperty(document, "elementFromPoint", previousHitTest)
    else Reflect.deleteProperty(document, "elementFromPoint")
  }
})

test("collection queries preserve all matches and full text outside snapshot limits", async () => {
  document.body.replaceChildren()
  const fullText = `  ${"x".repeat(600)}\n  original spacing  `
  for (let index = 0; index < 601; index += 1) {
    const paragraph = document.createElement("p")
    paragraph.textContent = index === 0 ? fullText : `Paragraph ${index}`
    document.body.append(paragraph)
  }
  Object.defineProperty(document.querySelector("p")!, "innerText", {
    configurable: true,
    value: "Rendered first paragraph",
  })
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const request = {
    query: { steps: [{ kind: "css", selector: "p" }] },
    operation: "query",
    strict: false,
  }

  await expect(api.locator({ ...request, args: { collection: "count" } })).resolves.toMatchObject({
    ok: true,
    value: 601,
  })
  const text = await api.locator({ ...request, args: { collection: "allTextContents" } })
  expect(text.value).toHaveLength(601)
  expect((text.value as string[])[0]).toBe(fullText)
  const innerText = await api.locator({ ...request, args: { collection: "allInnerTexts" } })
  expect((innerText.value as string[])[0]).toBe("Rendered first paragraph")
  await expect(api.locator(request)).resolves.toMatchObject({ count: 601, truncated: true })
  const last = await api.locator({ ...request, index: 600 })
  expect(last.nodes).toHaveLength(1)
  expect(last.nodes?.[0].name).toBe("Paragraph 600")
})

test("dispatchEvent uses DOM initialization and event classes in the target realm", async () => {
  document.body.innerHTML = "<iframe></iframe>"
  const frameDocument = document.querySelector("iframe")!.contentDocument!
  frameDocument.body.innerHTML =
    '<div id="event-parent"><button id="event-target">Target</button></div>'
  const target = frameDocument.getElementById("event-target")!
  const parent = frameDocument.getElementById("event-parent")!
  const mouseEvents: MouseEvent[] = []
  const keyEvents: KeyboardEvent[] = []
  const customEvents: CustomEvent[] = []
  const bubbled = jest.fn()
  target.addEventListener("click", (event) => mouseEvents.push(event as MouseEvent))
  target.addEventListener("keydown", (event) => keyEvents.push(event as KeyboardEvent))
  target.addEventListener("custom-event", (event) => customEvents.push(event as CustomEvent))
  parent.addEventListener("click", bubbled)
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const dispatch = (type: string, eventInit: Record<string, unknown>) =>
    api.locator({
      query: { steps: [{ kind: "css", selector: "#event-target" }] },
      operation: "action",
      name: "dispatchEvent",
      args: { type, eventInit },
      options: { scroll: "none" },
    })

  await expect(
    dispatch("click", { button: 2, clientX: 42, bubbles: false })
  ).resolves.toMatchObject({ ok: true })
  await expect(
    dispatch("keydown", { key: "Enter", code: "Enter", ctrlKey: true })
  ).resolves.toMatchObject({ ok: true })
  await expect(dispatch("custom-event", { detail: { value: "payload" } })).resolves.toMatchObject({
    ok: true,
  })
  expect(Object.getPrototypeOf(mouseEvents[0])).toBe(
    Object.getPrototypeOf(frameDocument.createEvent("MouseEvent"))
  )
  expect(mouseEvents[0]).toMatchObject({ button: 2, clientX: 42, isTrusted: false })
  expect(bubbled).not.toHaveBeenCalled()
  expect(Object.getPrototypeOf(keyEvents[0])).toBe(
    Object.getPrototypeOf(frameDocument.createEvent("KeyboardEvent"))
  )
  expect(keyEvents[0]).toMatchObject({ key: "Enter", code: "Enter", ctrlKey: true })
  expect(customEvents[0].detail).toEqual({ value: "payload" })
})

test("a target detached while scrolling never receives the pending click", async () => {
  document.body.innerHTML = '<button id="detaching-target">Target</button>'
  const target = document.getElementById("detaching-target")!
  const clicked = jest.fn()
  target.addEventListener("click", clicked)
  Object.defineProperty(target, "scrollIntoView", {
    configurable: true,
    value: () => target.remove(),
  })
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug

  await expect(
    api.locator({
      query: { steps: [{ kind: "css", selector: "#detaching-target" }] },
      operation: "action",
      name: "click",
      options: { force: true },
    })
  ).resolves.toMatchObject({ ok: false, code: "not_attached", retryable: true })
  expect(clicked).not.toHaveBeenCalled()
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

test.each(["cancel", "native-cleanup", "deadline"])(
  "%s during a suspended stability check prevents a later click",
  async (interruption) => {
    document.body.innerHTML = `<button id="pending">Pending</button>`
    installAgentDebug()
    const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
    const core = (
      window as unknown as {
        __cogniaAutomationCore: { isStable: (element: Element) => Promise<boolean> }
      }
    ).__cogniaAutomationCore
    const click = jest.fn()
    document.querySelector("button")!.addEventListener("click", click)
    let resume!: (stable: boolean) => void
    const stable = jest.spyOn(core, "isStable").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resume = resolve
        })
    )
    const startedAt = Date.now()
    let now = startedAt
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now)
    const control = { cancelled: false }
    try {
      const requestId = `pending-${interruption}`
      const pending = api.locator(
        {
          query: { steps: [{ kind: "css", selector: "#pending" }] },
          operation: "action",
          name: "click",
          requestId,
          expiresAt: startedAt + 10_000,
          options: { scroll: "none", timeout: 10_000 },
          requirements: { stable: true },
        },
        control
      )
      expect(resume).toBeDefined()
      if (interruption === "cancel") await api.locator({ operation: "cancel", requestId })
      if (interruption === "native-cleanup") control.cancelled = true
      if (interruption === "deadline") now += 10_001
      resume(true)
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: interruption === "deadline" ? "action_timeout" : "action_cancelled",
        retryable: false,
        dispatchState: "not-dispatched",
      })
      expect(click).not.toHaveBeenCalled()
    } finally {
      stable.mockRestore()
      clock.mockRestore()
    }
  }
)

test("cancellation arriving before its action leaves a tombstone", async () => {
  document.body.innerHTML = `<button id="cancel-first">Pending</button>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const click = jest.fn()
  document.querySelector("button")!.addEventListener("click", click)
  await api.locator({ operation: "cancel", requestId: "cancel-before-start" })
  await expect(
    api.locator({
      query: { steps: [{ kind: "css", selector: "#cancel-first" }] },
      operation: "action",
      name: "click",
      requestId: "cancel-before-start",
    })
  ).resolves.toMatchObject({ ok: false, code: "action_cancelled", dispatchState: "not-dispatched" })
  expect(click).not.toHaveBeenCalled()
})

test("an expired queued action cannot bypass its deadline with force", async () => {
  document.body.innerHTML = `<button id="expired">Expired</button>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const click = jest.fn()
  document.querySelector("button")!.addEventListener("click", click)
  await expect(
    api.locator({
      query: { steps: [{ kind: "css", selector: "#expired" }] },
      operation: "action",
      name: "click",
      expiresAt: Date.now() - 1,
      options: { force: true },
    })
  ).resolves.toMatchObject({ ok: false, code: "action_timeout", dispatchState: "not-dispatched" })
  expect(click).not.toHaveBeenCalled()
})

test("an action ID cannot dispatch twice within its retained deadline", async () => {
  document.body.innerHTML = `<button id="once">Once</button>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const click = jest.fn()
  document.querySelector("button")!.addEventListener("click", click)
  const request = {
    query: { steps: [{ kind: "css", selector: "#once" }] },
    operation: "action",
    name: "click",
    requestId: "dispatch-once",
  }
  await expect(api.locator(request)).resolves.toMatchObject({
    ok: true,
    dispatchState: "dispatched",
  })
  await expect(api.locator(request)).resolves.toMatchObject({
    ok: false,
    code: "duplicate_action",
    dispatchState: "dispatched",
  })
  expect(click).toHaveBeenCalledTimes(1)
})

test.each(["ambiguous", "hidden", "detached", "replaced", "retargeted"] as const)(
  "a %s drag target cannot receive a drag selected from another DOM state",
  async (condition) => {
    document.body.innerHTML = `<button id="source">Drag</button><div class="target">Drop</div>`
    installAgentDebug()
    const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
    const core = (
      window as unknown as {
        __cogniaAutomationCore: {
          isStable: (element: Element) => Promise<boolean>
          receivesEvents: (element: Element) => boolean
        }
      }
    ).__cogniaAutomationCore
    const source = document.getElementById("source")!
    const target = document.querySelector(".target") as HTMLElement
    const dragstart = jest.fn()
    source.addEventListener("dragstart", dragstart)
    if (condition === "ambiguous") target.after(target.cloneNode(true))
    if (condition === "hidden") target.style.display = "none"
    const hit = jest.spyOn(core, "receivesEvents").mockReturnValue(true)
    const stable = jest.spyOn(core, "isStable").mockImplementation(async () => {
      if (condition === "detached") target.remove()
      if (condition === "replaced") target.replaceWith(target.cloneNode(true))
      if (condition === "retargeted") {
        target.before(target.cloneNode(true))
        target.classList.remove("target")
      }
      return true
    })
    try {
      await expect(
        api.locator({
          query: { steps: [{ kind: "css", selector: "#source" }] },
          operation: "action",
          name: "dragTo",
          args: { targetQuery: { steps: [{ kind: "css", selector: ".target" }] } },
          options: { scroll: "none" },
        })
      ).resolves.toMatchObject({
        ok: false,
        dispatchState: "not-dispatched",
        code: {
          ambiguous: "strict_mode_violation",
          hidden: "target_not_visible",
          detached: "target_not_attached",
          replaced: "target_not_attached",
          retargeted: "target_changed",
        }[condition],
      })
      expect(dragstart).not.toHaveBeenCalled()
    } finally {
      hit.mockRestore()
      stable.mockRestore()
    }
  }
)

test("drag target filters and last select one endpoint inside a trial action", async () => {
  document.body.innerHTML = `<button id="source">Drag</button><div class="target">Other</div>
    <div class="target">Drop first</div><div class="target">Drop last</div>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const core = (
    window as unknown as {
      __cogniaAutomationCore: { receivesEvents: (element: Element) => boolean }
    }
  ).__cogniaAutomationCore
  const checked: string[] = []
  const hit = jest.spyOn(core, "receivesEvents").mockImplementation((element) => {
    checked.push(element.textContent || "")
    return true
  })
  try {
    await expect(
      api.locator({
        query: { steps: [{ kind: "css", selector: "#source" }] },
        operation: "action",
        name: "dragTo",
        args: {
          targetQuery: {
            kind: "filtered",
            query: { steps: [{ kind: "css", selector: ".target" }] },
            filters: [{ kind: "hasText", value: "Drop" }],
            index: -1,
          },
        },
        options: { scroll: "none", trial: true },
      })
    ).resolves.toMatchObject({ ok: true })
    expect(checked.length).toBeGreaterThan(0)
    expect(checked.every((text) => text === "Drop last")).toBe(true)
  } finally {
    hit.mockRestore()
  }
})

test("strict state queries reject multiple matches but permit zero matches", async () => {
  document.body.innerHTML = `<button>First</button><button>Second</button>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  await expect(
    api.locator({
      query: { steps: [{ kind: "css", selector: "button" }] },
      operation: "query",
      strict: true,
    })
  ).resolves.toMatchObject({ ok: false, code: "strict_mode_violation" })
  await expect(
    api.locator({
      query: { steps: [{ kind: "css", selector: "missing" }] },
      operation: "query",
      strict: true,
    })
  ).resolves.toMatchObject({ ok: true, nodes: [] })
})

test("the reference action keeps legacy destination indices on the atomic drag path", async () => {
  document.body.innerHTML = `<button id="source">Drag</button><div class="target">First</div><div class="target">Second</div>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const core = (
    window as unknown as {
      __cogniaAutomationCore: {
        isStable: (element: Element) => Promise<boolean>
        receivesEvents: (element: Element) => boolean
      }
    }
  ).__cogniaAutomationCore
  const stable = jest.spyOn(core, "isStable").mockResolvedValue(true)
  const hit = jest.spyOn(core, "receivesEvents").mockReturnValue(true)
  const previousTransfer = Object.getOwnPropertyDescriptor(window, "DataTransfer")
  const previousDrag = Object.getOwnPropertyDescriptor(window, "DragEvent")
  Object.defineProperty(window, "DataTransfer", { configurable: true, value: class {} })
  Object.defineProperty(window, "DragEvent", {
    configurable: true,
    value: class extends MouseEvent {
      dataTransfer: unknown
      constructor(type: string, init: MouseEventInit & { dataTransfer?: unknown }) {
        super(type, init)
        this.dataTransfer = init.dataTransfer
      }
    },
  })
  const events: string[] = []
  for (const element of document.querySelectorAll("button, .target"))
    for (const type of ["dragstart", "dragenter", "dragover", "drop", "dragend"])
      element.addEventListener(type, () => events.push(`${element.textContent}:${type}`))
  try {
    const source = api.snapshot().nodes.find((node) => node.name === "Drag")!
    await expect(
      api.act(source.ref, "dragTo", {
        targetQuery: { steps: [{ kind: "css", selector: ".target" }] },
        targetIndex: 1,
      })
    ).resolves.toMatchObject({ action: "dragTo", ref: source.ref })
    expect(events).toEqual([
      "Drag:dragstart",
      "Second:dragenter",
      "Second:dragover",
      "Second:drop",
      "Drag:dragend",
    ])
    events.length = 0
    const second = document.querySelectorAll(".target")[1]
    second.addEventListener("dragenter", () => second.remove(), { once: true })
    await expect(
      api.act(source.ref, "dragTo", {
        targetQuery: { steps: [{ kind: "css", selector: ".target" }] },
        targetIndex: 1,
      })
    ).rejects.toThrow("endpoint detached after dragstart")
    expect(events).toEqual(["Drag:dragstart", "Second:dragenter", "Drag:dragend"])
  } finally {
    stable.mockRestore()
    hit.mockRestore()
    if (previousTransfer) Object.defineProperty(window, "DataTransfer", previousTransfer)
    else Reflect.deleteProperty(window, "DataTransfer")
    if (previousDrag) Object.defineProperty(window, "DragEvent", previousDrag)
    else Reflect.deleteProperty(window, "DragEvent")
  }
})

test("document departure cancels pending input and restored documents cannot alias old refs", async () => {
  document.body.innerHTML = `<button id="incarnation">Run</button>`
  installAgentDebug()
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const core = (
    window as unknown as {
      __cogniaAutomationCore: { isStable: (element: Element) => Promise<boolean> }
    }
  ).__cogniaAutomationCore
  const clicks = jest.fn()
  document.querySelector("button")!.addEventListener("click", clicks)
  const restored = new Event("pageshow")
  Object.defineProperty(restored, "persisted", { value: true })
  window.dispatchEvent(restored)
  const oldRef = api.snapshot().nodes[0].ref
  let resume!: (value: boolean) => void
  const stable = jest.spyOn(core, "isStable").mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        resume = resolve
      })
  )
  try {
    const pending = api.locator({
      query: { steps: [{ kind: "css", selector: "#incarnation" }] },
      operation: "action",
      name: "click",
      requestId: "document-departure",
      options: { scroll: "none" },
      requirements: { stable: true },
    })
    window.dispatchEvent(new Event("pagehide"))
    resume(true)
    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "webview_document_replaced",
      dispatchState: "not-dispatched",
    })
    window.dispatchEvent(restored)
    const newRef = api.snapshot().nodes[0].ref
    expect(newRef).toMatch(/^d[\w-]+:g1e1$/)
    expect(newRef.split(":")[1]).toBe(oldRef.split(":")[1])
    expect(newRef).not.toBe(oldRef)
    await expect(api.act(oldRef, "click")).rejects.toThrow("stale or unknown element ref")
    expect(clicks).not.toHaveBeenCalled()
  } finally {
    stable.mockRestore()
    window.dispatchEvent(restored)
  }
})
