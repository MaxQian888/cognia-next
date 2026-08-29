---
"cognia-next": patch
---

Fix the Browser Companion's template, replay and stop paths, and make the sandbox tier un-pin stick

- A template delivery target could never be submitted: the side panel sent an empty `instruction`, which the RPC request schema (`required`, `minLength: 1`) refused before the Host ever saw it.
- Replaying an already-accepted submission no longer re-resolves its delivery target, so the ordinary lost-response retry is answered with the original receipt instead of `unknown_target` — and no longer re-records a template use.
- Stopping a task now reports the Host's actual refusal. Every non-applied outcome used to be reported as "another device is driving this task", sending people to a machine that was not driving anything.
- The append-to-conversation dropdown counts targets offered rather than rows scanned, so filing a few pages as issues no longer empties it.
- Issue boards in `backlog` — the state every newly created board starts in — are offered as file-here targets.
- "Follow the default again" on the composer's sandbox shield now holds; the next message used to re-pin the tier it had just released.
- Codex managed/enterprise limits are read before the first request can outrun them, the refusal is classified as `managed_policy_refused` with localized recovery advice, and the status card distinguishes "not read yet" from "declares no limits" and names an allowlist that permits nothing.
- A truncated task answer is cut on a codepoint boundary, so an emoji at the ceiling no longer becomes a replacement character.
- The capability digest that rides on every list poll is cached for a beat instead of rebuilding the whole delivery-target catalogue and palette every three seconds, and reading a task's answer scans the tail of the transcript instead of loading all of it.
