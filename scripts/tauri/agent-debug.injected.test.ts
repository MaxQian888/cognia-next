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
  installDialogHandler: (options?: Record<string, unknown>) => boolean
  getDialogs: () => Array<{ type: string; message: string }>
  drainConsole: () => unknown[]
}

const code = fs.readFileSync(
  path.join(__dirname, "../../src-tauri/src/agent_debug/injected.js"),
  "utf8"
)

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

  ;(0, eval)(code)
  const api = (window as unknown as { __cogniaAgentDebug: AgentDebugApi }).__cogniaAgentDebug
  const first = api.snapshot()
  expect(api.version).toBe(2)
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
