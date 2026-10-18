# Independent Sign in with ChatGPT implementation

Authorization confirmed on 2026-10-18: implement independent OAuth, protected storage,
refresh/sign-out, app-server, ordinary chat and synthetic tests. Existing subscriptions,
accounts, selections and authorization files must remain unchanged. Real-account OAuth,
refresh and inference are outside this validation scope.

1. Native registration and rotating credentials → verify fake issuer, signed ID tokens,
   cross-process locks, durable refresh intent, cancellation and deletion races.
2. Native Responses transport → verify fixed destination, final JSON PII gate, preview
   restrictions, bounded pull streaming, cancellation before headers and incomplete SSE.
3. Ordinary chat provider → verify explicit secret-free connection references, native
   transport for main/summary/vision calls and no credential/provider fallback.
4. app-server adapter → verify separate protocol, native-only scoped proxy capability,
   isolated state root and account/connection/Host binding across reconnect.
5. Account center → verify explicit configuration, original-scope cleanup, ABA account
   switching, model entitlement, revocation disclosure and bilingual strings.
6. Integration → run focused Rust/Jest checks, i18n generation/parity, type/lint checks
   and targeted security/wiring reviews. Report native UI and real-account evidence
   separately; do not activate a real connection during these checks.

The existing native credential owner is extended rather than adding a renderer vault.
New SIWC files are justified by the requirement that legacy account enumeration,
exports, refresh and old binaries cannot consume these credentials. The native
Responses module is shared by RPC and the app-server proxy so final request enforcement
has one owner. The proxy replaces the proposal's direct OAuth environment injection:
the child receives only a revocable local capability, and the Host renews upstream
credentials per request. No cloud relay or billing fallback is introduced.

Concurrency: fresh OS-locked encrypted envelopes own credential mutation; a durable
refresh intent prevents replay after a crash. Unlock generations fence asynchronous
operations, including A→B→A. Request ownership is bounded, cancellation covers headers
and body, and stale cleanup cannot remove a successor. Sign-out/deletion cancel native
execution before clearing credentials. Existing dirty-tree changes remain owned by
their respective sessions; no broad staging, reset, stash or formatting is permitted.

Known upstream gate: `earliest_refresh_at` has no published unit/type semantics in the
reviewed token reference. Preserve it opaque and refuse an ambiguous rotation rather
than guessing; retain any still-valid access lease and expose reauthorization when
renewal cannot safely proceed. This limitation must remain visible in delivery notes.
