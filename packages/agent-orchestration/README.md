# @cognia/agent-orchestration

The host-independent core of the durable Agent Team (ADR-0217): run records,
the `TeamRunStore` port with a reference memory store and its conformance
contract (`./store-contract`), persistence rules, replay safety and attempt
fencing, the decision and evidence ledgers, fair scheduling, usage accounting,
and `createDurableTeamCoordinator` (`./coordinator`), which covers admission,
workspace leases, steering, pause, takeover and recovery.

No dependencies. The host supplies the store, a run journal, a required
persistence redactor, a path policy, remote-session release and, per running
teammate, a `DurableChildControl`. The store is the only state authority; the
coordinator keeps process-local, rebuildable state only.

```ts
import { createDurableTeamCoordinator } from "@cognia/agent-orchestration/coordinator"
import { createMemoryTeamRunStore } from "@cognia/agent-orchestration/memory-store"
```

The app binding is `lib/ai/agent/team/durable/durable-runtime.ts` (Dexie store
in `lib/db/agent-team-runtime.ts`). Checked by
`node scripts/build/pack-test-agent-package.mjs agent-orchestration`. Details:
`docs/content/docs/en/subsystems/agent-packages/orchestration.mdx`.
