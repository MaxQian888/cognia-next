import { registerNodeExecutor } from "../registry"
import { PASSTHROUGH_TRIGGER_KINDS, runTriggerPassthrough } from "../shared/executor-support"

for (const kind of PASSTHROUGH_TRIGGER_KINDS) {
  registerNodeExecutor({ kind, typeVersion: 1, execute: runTriggerPassthrough })
}
