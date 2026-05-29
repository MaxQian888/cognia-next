import {
  registerScheduledTaskDefsForPlugin,
  unregisterScheduledTaskDefsByPlugin,
  listScheduledTaskDefs,
  subscribeScheduledTaskDefs,
  __resetScheduledTaskRegistryForTesting,
} from "./scheduled-task-registry"
import type { PluginScheduledTaskDef } from "@/types/plugin/plugin"

const def = (name: string): PluginScheduledTaskDef => ({
  name,
  handler: "run",
  trigger: { type: "interval", seconds: 60 },
})

afterEach(() => {
  __resetScheduledTaskRegistryForTesting()
})

describe("scheduled-task-registry", () => {
  it("registers defs and replaces the plugin's prior set", () => {
    expect(registerScheduledTaskDefsForPlugin("p1", [def("a"), def("b")])).toBe(2)
    expect(listScheduledTaskDefs()).toHaveLength(2)
    expect(registerScheduledTaskDefsForPlugin("p1", [def("c")])).toBe(1)
    expect(listScheduledTaskDefs().map((t) => t.def.name)).toEqual(["c"])
  })

  it("skips defs with a blank name", () => {
    expect(registerScheduledTaskDefsForPlugin("p1", [def("  ")])).toBe(0)
    expect(listScheduledTaskDefs()).toHaveLength(0)
  })

  it("scopes removal to the named plugin", () => {
    registerScheduledTaskDefsForPlugin("p1", [def("a")])
    registerScheduledTaskDefsForPlugin("p2", [def("b")])
    expect(unregisterScheduledTaskDefsByPlugin("p1")).toBe(1)
    expect(listScheduledTaskDefs().map((t) => t.pluginId)).toEqual(["p2"])
    expect(unregisterScheduledTaskDefsByPlugin("ghost")).toBe(0)
  })

  it("notifies subscribers and caches the snapshot", () => {
    const fires: number[] = []
    const unsub = subscribeScheduledTaskDefs(() => fires.push(listScheduledTaskDefs().length))
    const first = listScheduledTaskDefs()
    expect(listScheduledTaskDefs()).toBe(first)
    registerScheduledTaskDefsForPlugin("p1", [def("a")])
    expect(fires).toEqual([1])
    unsub()
  })
})
