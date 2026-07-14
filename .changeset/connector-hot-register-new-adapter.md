---
"cognia-next": patch
---

A newly configured IM bot now works without restarting the app. The connector runtime read the enabled-adapter list only once at boot, so a bot created or enabled afterward was never registered with the bus — outbound (including the "send test message" button) failed with `adapter_not_found`, and inbound never started. The runtime now watches the `adapterInstances` table and reconciles the enabled set live: it registers and starts a newly enabled/created adapter, and stops and unregisters one that was disabled or deleted. The reconcile diffs by id, so unrelated row writes (presence, capability, heartbeat) don't churn a running connection.
