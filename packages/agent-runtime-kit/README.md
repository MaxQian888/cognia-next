# @cognia/agent-runtime-kit

Building blocks for Cognia external-agent adapters (ADR-0217):
`BaseProtocolAdapter` (session registry, turn usage folding, permission routing),
the JSON-RPC peer and LF frame decoder, content blocks, orphan-process reclaim,
unsupported-extension errors, permission-mode ranking, history part builders
(`./history`), the outbound-gate prompt check that also decodes text hidden in
base64 blocks (`./prompt-gate`) and the plugin adapter compatibility wrapper
(`./plugin-compat`).

Depends only on `@cognia/agent-contracts`. Machine access comes from the host
through the contract's ports.

```ts
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import { historyText, historyTool } from "@cognia/agent-runtime-kit/history"
```

Checked by `node scripts/build/pack-test-agent-package.mjs agent-runtime-kit`.
How to build an integration on it:
`docs/content/docs/en/subsystems/agent-packages/adding-an-agent.mdx`.
