---
"cognia-next": minor
---

Replace the single-`CompanionConfig` pairing record with a multi-host credential book: public `CompanionHostRecord`s (endpoints, TLS pin, immutable cursor namespace, generation-guarded connection state) are kept apart from `CompanionHostCredential`s, which never leave the browser Vault or the platform keystore. Pairings are addressed by `{hostId, accountNamespace}`, so the same desktop paired from two accounts no longer shares a token, a watermark, or a mirrored row. Existing pairings migrate once, and the legacy record is only removed after both halves are read back and verified.
