import { getTwinRuntimeSettings } from "@/lib/db/twin-runtime-settings"
import { startJobWorker } from "@/lib/twin/job-worker"
import { buildTwinWorkerConfig } from "@/lib/twin/worker-runtime"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "twin-job-worker",
  hosts: ["brain"],
  start: async (ctx) => {
    const settings = await getTwinRuntimeSettings()
    const config = await buildTwinWorkerConfig(settings)
    if (!config) {
      ctx.log("warn", "Twin job worker is disabled or its runtime configuration is incomplete")
      return
    }
    const handle = startJobWorker(config)
    ctx.log("info", "Twin job worker started")
    return () => handle.stop()
  },
})
