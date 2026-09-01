import { createNativeNodePerformanceProvider, NodePerformanceHost } from "@/lib/perf/node-host"
import { registerPerformanceHostAdapter } from "@/lib/perf/host-adapter"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "performance-host",
  hosts: ["brain"],
  start: async (ctx) => {
    const provider = await createNativeNodePerformanceProvider()
    const host = new NodePerformanceHost(provider, {
      // Braces discard the bridge's resolved value: the `emit` seam promises
      // `void`, not whatever the RPC happens to return.
      emit: async (deviceId, frame) => {
        // invoke-parity-exempt: a `ws_bridge.rs:route_respond` route, not a Tauri command — the brain reaches it over `/internal/bridge`, and `route_respond` validates the topic against a closed allowlist before publishing.
        await ctx.bridge.invoke("companion_perf_frame", {
          deviceId,
          event: "perf://frame",
          frame,
        })
      },
    })
    const unregister = registerPerformanceHostAdapter(host)
    return async () => {
      unregister()
      await host.stop()
    }
  },
})
