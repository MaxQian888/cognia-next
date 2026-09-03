---
"cognia-next": patch
---

Regenerate the embedded host command contract, which had drifted from its source manifest. Five sync tables (connectorCallbackBindings, connectorHeartbeats, executionRunBindings, platformIdentities, workflowDeployments) were rejected with a 422 on every pull from a paired browser or phone, host-originated permission prompts could not be answered from a companion because the contract still demanded a remote execution context, external agent runtime detection was missing from the contract entirely, and spawning an external agent asked for a signed policy that no client mints.
