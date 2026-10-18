# @cognia/agent-dsh

DeepSeek Harness integration (ADR-0217): the `dsh-sdk` protocol adapter
(`./sdk-client`), its process transport over a host-provided
`AgentProcessHost` (`./transport`), the session event codec, the managed
runtime channel, installer facts and managed-launch preparation, and the
integration manifest (`./manifest`, pure data).

The managed release is `0.2.1-rc.2` (conformance suite 4). SDK prompt
admission is followed by `session/wait`: root idle alone does not complete a
Cognia turn while managed descendants are still progressing. Job lifecycle and
working-directory events remain progress observations. Native SDK resume remains
unsupported by this adapter and is reserved for a separate integration.

DeepSeek Harness has no wire cancel: stopping a turn retires the session's own
process, so the manifest declares a `process`-scoped cancel that needs a
reconnect. Hosts and the team coordinator act on that declaration.

```ts
import { deepseekHarnessManifest } from "@cognia/agent-dsh/manifest"
import { DshSdkClientAdapter } from "@cognia/agent-dsh/sdk-client"
```

The app wires it in `lib/ai/agent/external/integrations/dsh.ts`. Checked by
`node scripts/build/pack-test-agent-package.mjs agent-dsh`.
