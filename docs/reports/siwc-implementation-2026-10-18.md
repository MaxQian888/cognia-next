# Independent SIWC implementation — 2026-10-18

The maintainer approved independent login, protected credentials, refresh/sign-out,
app-server, ordinary chat and synthetic tests. Existing subscriptions, accounts,
default selections and authorization files were not migrated or activated. No real
OAuth, user-token refresh or inference was performed. Changes are local and uncommitted.

## Implemented behavior

- The Account Center adds a separate SIWC panel. It supports native browser login,
  cancellation, same-registration retry, renewal, sign-out/revocation disclosure,
  signed-out deletion, catalog discovery and explicit chat/app-server configuration.
- OAuth, issued-client mappings and tokens remain native. A separate encrypted
  envelope uses namespace authentication, fresh OS-locked reads, atomic replacement,
  durable refresh intent, credential revisions and deletion tombstones. Ambiguous
  exchanges are not replayed. Email is display-only, not a registration key.
- Profile unlock generations fence asynchronous work, including A→B→A. Publication
  uses the same lock order as invalidation. Old queued destructive operations cannot
  clear a successor's credentials. Blocking disk/crypto/fsync work runs off the async
  executor, while refresh retains its OS writer lock through exchange and commit.
- Ordinary chat, feature generation, summaries and optical read-back use native
  Responses RPC. Non-stream feature generation consumes the required SSE internally.
  Known automatic output caps are omitted; explicit unsupported caller constraints
  fail closed. Ledgered auxiliary calls refuse when their hard cap cannot be enforced.
- app-server uses a distinct `codex-siwc-app-server` protocol, an isolated history root
  derived from profile/registration/Host, and a native loopback capability. The child
  never receives OAuth. Native send rejects account login/logout, credential refresh,
  provider mutations and imported-history paths. Generic process send cannot bypass
  that boundary. Local capabilities are removed from retained process metadata.
- Both execution paths validate the final Responses JSON, including native Codex
  context and tool results. Cancellation covers admission, header wait, body reads,
  dropped futures, sign-out and account locking. Request ownership is bounded and
  cancelled UUIDs remain retired long enough to prevent cancel-before-open races.
- Configuring SIWC does not change the current model/provider/account. app-server
  configurations start disabled. Automatic routing, classifiers, mappings and saved
  fallback chains cannot silently switch into or out of SIWC. Only catalog entries
  with `visibility: "list"` are offered/configured.
  An automatic request whose global default is SIWC also stops for explicit
  provider selection, rather than skipping SIWC and charging a legacy API provider.
  Concurrent chat setup uses a stable profile/registration/model ID so the
  existing settings queue converges on one provider entry.
- All fourteen commands are desktop-local/internal. Headless provisioning/transfer
  is unavailable. Native shutdown invalidates SIWC before child-process teardown.

The native loopback proxy is a deliberate refinement of the proposal's direct OAuth
environment injection: it intercepts the final body and resolves current native
credentials per request, avoiding stale child tokens after rotation. It introduces
no cloud relay or alternate billing destination.

## Verification

| Layer                               | Evidence                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Credential/storage/Responses crate  | 246 tests passed, including 39 SIWC tests and native app-server policy tests                                       |
| Secret namespace sealing            | 1 focused test passed; no real keychain access                                                                     |
| External process protection         | 2 focused tests passed, including a synthetic child, generic-send refusal and capability redaction                 |
| UI/transport/configuration          | Final six-suite run: 52 passed; model-visibility regressions failed before the fix and passed afterward            |
| Routing/provider regression group   | 616 passed; includes provider resolution, saved fallback chains and build-options fixtures                         |
| Final routing guard                 | 117 passed across provider resolution and saved fallback suites; the SIWC-default regression failed before the fix |
| Additional manager/editor/contracts | Focused suites passed; groups overlap and are not added into a single total                                        |
| Sidecar                             | Final seven-suite run: 212 passed, 0 failed/skipped; includes actual installed-SDK wire fixtures                   |
| Native Host unit tests              | Final linked desktop library: 6 passed, 0 failed; 1327 unrelated tests filtered                                    |
| Native compilation                  | `cargo check -p cognia-next --lib --no-default-features` and `--tests` passed with unrelated warnings              |
| Generated contracts                 | Companion API check: 932 remote commands / 113 classified routes; agent capability audit passed                    |
| Localization                        | Split en/zh parity, generated freshness, ICU validation, sort check and i18n lint passed                           |
| Source review                       | i18n/test adjacency/static-export review clean; PII, native concurrency and wiring findings addressed              |

Initial native test builds exhausted disk space. Only rebuildable Rust
intermediate/cache artifacts were removed; source, application data and authorization
files were preserved. The final native Host build/link completed after cache recovery, and all six selected SIWC tests passed; the full native test suite was not executed.

Full workspace TypeScript is not green: the attempted check reports errors in
concurrent chat/session/subagent/capability/usage changes. The newly added settings
fixture error was fixed and its focused suite rerun. Sidecar TypeScript separately
reports the untouched `claude-agent-sdk/options.test.ts:69` undefined reviewer fixture.
The network-egress audit reports nine sites outside the SIWC changes, with no SIWC
site among them. The headless roster test expects 41 registrations but sees 42
(including existing behavior telemetry); the SIWC roster change is a comment only.
These are not presented as passing global gates and were not changed by this task.

Two final package-script attempts triggered automatic dependency synchronization
against concurrent workspace changes and failed under disk pressure. Those attempts
are not counted as checks. Localization validation was rerun directly with Node;
missing generated TypeScript bin links were restored. SIWC adds no JavaScript
package dependency; the unrelated workspace manifest/lock changes remain preserved.

## Remaining acceptance boundaries

- A subsequent [desktop acceptance follow-up](./siwc-tauri-acceptance-2026-10-18.md)
  verified the real Tauri empty state, icons and native cross-profile rejection,
  and repaired a concurrent configuration race. Connected-state UI interactions
  remain pending a stable shared window. Real authorization, entitlement/quota,
  provider inference and other native platforms have not been exercised.
  The earlier Codex 0.159.2/0.163.0 local
  fixture report is separate evidence, not a composed SIWC service canary.
- The published token reference names `earliest_refresh_at` without a verified
  type/unit/scheduling contract. It is retained opaque. A still-valid token remains
  usable, but renewal that depends on interpreting that value refuses safely and
  requires reauthorization. This prevents speculative token-rotation scheduling.
- Opaque binary documents and remote attachment URLs are refused. UTF-8 text files
  are decoded and checked. Inline image bytes follow the existing image path; the
  new text gate does not claim OCR/pixel PII detection.
- Desktop SIWC credentials are excluded from legacy enumeration/export/sync. A
  future headless/master-key-rotation extension must re-seal separate envelopes;
  current desktop password/unlock flows do not rotate that master key. An unreadable
  or newer envelope fails closed and is not silently overwritten.
- Old builds cannot read the independent credential envelope. Their own generic
  fallback behavior cannot be retroactively controlled; do not treat downgrade as
  certified identity/billing continuity. Keep a capable build for SIWC use.

Sources: [registration/sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference),
[preview request limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[app-server contract](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
Installed OpenAI provider request serialization was checked against `@ai-sdk/openai 4.0.84`.
