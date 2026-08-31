---
"cognia-next": patch
---

Fix writes to account-encrypted Dexie tables. An empty bulk write (`bulkPut([])`, `bulkAdd([])`) and a `modify()` whose range matched no rows were both rejected as "criteria-only mutations", which made the Host dispatch queue log `queue drain failed` on every quiet tick. Both are now the no-ops they were always meant to be. Decryption on the `get` / `getMany` / `query` paths now holds the transaction open via `Dexie.waitFor`, so a read-modify-write such as `Table.update()` on an encrypted table no longer dies with `InvalidStateError`, and the field patch Dexie attaches to those writes is dropped so it can never land plaintext next to the ciphertext envelope.
