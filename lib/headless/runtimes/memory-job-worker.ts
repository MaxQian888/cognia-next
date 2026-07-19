import { startMemoryJobWorker } from "@/lib/memory/lifecycle/job-worker"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "memory-job-worker",
  hosts: ["brain"],
  start: () => startMemoryJobWorker({ workerId: "headless-memory-job-worker" }),
})
