---
"cognia-next": patch
---

Creating a conversation no longer crashes with `InvalidStateError: Failed to execute 'objectStore' on 'IDBTransaction': The transaction has finished.` The account-encryption layer holds the IndexedDB transaction open across its WebCrypto await, and it establishes that hold by touching the transaction, which throws if the transaction has already committed. It can commit without warning, because Dexie's own query cache sits below this layer and can answer a read without ever issuing a request to keep the transaction alive. The rows are already in hand at that point and decrypting them needs no transaction, so the read now completes instead of failing, and anything genuinely wrong with the caller's transaction is reported by Dexie under its own name.
