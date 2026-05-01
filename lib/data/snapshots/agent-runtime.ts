// Snapshot for `localStorage["cognia-next.agent-runtime"]`. Tiny store —
// holds the active runtime / mode id / external agent id pointer so the
// last-active agent reopens after restart. Cheap to back up.

import { createGenericSnapshotModule } from "./factory"

export const AGENT_RUNTIME_PERSIST_KEY = "cognia-next.agent-runtime"
export const AGENT_RUNTIME_LABEL_KEY = "agentRuntime"

export const agentRuntimeSnapshot = createGenericSnapshotModule({
  key: AGENT_RUNTIME_PERSIST_KEY,
  labelKey: AGENT_RUNTIME_LABEL_KEY,
  exposeAsDomain: true,
})
