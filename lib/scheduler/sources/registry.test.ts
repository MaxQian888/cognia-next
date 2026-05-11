import { createSchedulerSourceRegistry } from "./registry"
import type { ScheduledItemSource } from "./types"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

function makeStubSource(kind: ScheduledItemKind): ScheduledItemSource {
  return {
    kind,
    subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
    list: jest.fn(async () => []),
    get: jest.fn(async () => undefined),
    create: jest.fn(async () => {
      throw new Error("not implemented in stub")
    }),
    update: jest.fn(async () => {}),
    delete: jest.fn(async () => {}),
    pause: jest.fn(async () => {}),
    resume: jest.fn(async () => {}),
    runNow: jest.fn(async () => {}),
  }
}

describe("SchedulerSourceRegistry", () => {
  it("registers and retrieves sources by kind", () => {
    const reg = createSchedulerSourceRegistry()
    const app = makeStubSource("app")
    reg.register(app)
    expect(reg.has("app")).toBe(true)
    expect(reg.getSource("app")).toBe(app)
  })

  it("returns undefined for unregistered kinds", () => {
    const reg = createSchedulerSourceRegistry()
    expect(reg.getSource("workflow")).toBeUndefined()
    expect(reg.has("workflow")).toBe(false)
  })

  it("listAllSources returns every registered source", () => {
    const reg = createSchedulerSourceRegistry()
    reg.register(makeStubSource("app"))
    reg.register(makeStubSource("workflow"))
    reg.register(makeStubSource("backup"))
    const all = reg.listAllSources()
    expect(all.map((s) => s.kind).sort()).toEqual(["app", "backup", "workflow"])
  })

  it("re-registering the same kind replaces the prior entry", () => {
    const reg = createSchedulerSourceRegistry()
    const first = makeStubSource("plugin")
    const second = makeStubSource("plugin")
    reg.register(first)
    reg.register(second)
    expect(reg.getSource("plugin")).toBe(second)
    expect(reg.listAllSources()).toHaveLength(1)
  })

  it("unregister removes a source", () => {
    const reg = createSchedulerSourceRegistry()
    reg.register(makeStubSource("system"))
    expect(reg.has("system")).toBe(true)
    reg.unregister("system")
    expect(reg.has("system")).toBe(false)
  })

  it("clear empties the registry", () => {
    const reg = createSchedulerSourceRegistry()
    reg.register(makeStubSource("app"))
    reg.register(makeStubSource("workflow"))
    reg.clear()
    expect(reg.listAllSources()).toEqual([])
  })
})
