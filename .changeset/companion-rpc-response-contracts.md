---
"cognia-next": patch
---

Fix two Companion RPC commands that failed enforced response validation on every successful call, and start typing the remote response contracts. Reading a secret (`secret_store_get` / `keyring_secret_get`) returns a bare string or null but was declared as an object, and the Agent Fleet snapshot (`fleet_get_snapshot`) returns an object but was declared as an array — both were rejected with `contract_output_violation`, so remote and mobile clients could not read a secret or load the Fleet view at all. Also types the response schemas for the terminal, chat and diagnostics dispatch submodules (26 commands) from what each dispatch arm actually returns, and ratchets the remaining untyped-response count so it can only shrink.
