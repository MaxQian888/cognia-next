import { startIntegrationRuntime } from "@/lib/integrations/runtime"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "integration-runtime",
  criticality: "optional",
  hosts: ["brain"],
  start: () => startIntegrationRuntime(),
})
