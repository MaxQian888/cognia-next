import { startIntegrationRuntime } from "@/lib/integrations/runtime"
import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "integration-runtime",
  hosts: ["brain"],
  start: () => startIntegrationRuntime(),
})
