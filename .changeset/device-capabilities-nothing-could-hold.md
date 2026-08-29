---
"cognia-next": patch
---

Fix five companion capabilities that no device could ever hold. `client.read`, `client.write`, `performance.observe`, `performance.traces` and `performance.capture` were required by 33 commands in the command manifest but were granted by no role and rejected by the grant API, so every paired device — owner included — was refused by its own capability gate. The whole remote performance dashboard answered 403. Owner devices now receive all five by default, member devices receive `client.read`, and all five are assignable so a grant can be adjusted or revoked. Two new tests pin the invariant: every device capability the manifest can demand must be grantable, and an owner's default grants must cover every command the manifest exposes to device transports.
