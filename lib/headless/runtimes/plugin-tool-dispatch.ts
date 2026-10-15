/** Sidecar tool responses must be available before connectors accept turns. */
import { subscribePluginToolDispatchBridge } from "@/lib/claude/plugin-tool-dispatch-bridge"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "plugin-tool-dispatch",
  criticality: "required",
  hosts: ["brain"],
  start: () => subscribePluginToolDispatchBridge(),
})
