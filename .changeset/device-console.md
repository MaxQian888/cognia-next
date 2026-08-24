---
"cognia-next": minor
---

New Devices console at `/devices`, replacing the paired-devices table in Settings → Companion and the host list in Settings → Remote hosts with one fleet view over every machine the account can reach — this device, paired phones, remote hosts and execution workers.

It shows what the old surfaces held but never rendered: the capability manifest a device reports on every connect (with "never reported" kept visually distinct from "reported and lacks it", so an unheard-from device is not painted as twenty misses), live event-plane presence and open streams, and the host's own lifecycle verdict — so a device suspended from the CLI or the Owner API no longer reads as active while every call from it is refused. Each grant is expanded into the SecurityStore capabilities it confers and gains a **Partial** state, which previously rendered identically to "not granted".

The Runtime tab connects devices to the sandbox and workspace runtimes: available shell tiers with the concrete reason each unavailable one refuses, the sandbox connection registry for this machine, workspace environments for whichever host execution currently routes to (with a control to switch), and the scheduled timing authority. The Activity tab shows the durable dispatch queue per device and what the device offers a placement decision, which is the answer to "why does this machine never get picked".

The header carries a count of the devices that need looking at — revoked, disagreeing with the host about their own lifecycle, or connected but broken — so those are findable without opening each row in turn. Offline is deliberately not counted: a phone in a pocket is offline by design, and counting it would leave the badge permanently lit.

Pairing a device and adding a host stay in Settings; both tabs now link into the console. On mobile, the Me → Devices entry opens the same console.
