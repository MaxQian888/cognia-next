# Browser Companion hardening and separation readiness

Date: 2026-10-23. Scope: harden the existing workspace before a later repository extraction.

## Implemented boundaries

Drive revocation, socket disconnect, agent-mode disablement, Stop and Take over
cancel pending execution. The cancellation signal reaches pending site decisions,
the executor and multi-step native Chrome adapters. Every subsequent asynchronous
browser boundary checks it. An API already dispatched to Chrome cannot be recalled;
this change prevents later calls and prevents an aborted operation reporting success.

Stop now cancels the Host turn and leaves the session paused, with Resume available
on the page. Stop and Take over gate new operations before asynchronous cleanup and
persist the pause in session storage. Only an explicit Resume restores execution.
While paused, only reads of existing pages are allowed. Release/finalize cannot
erase the pause, close tabs or let later frames recreate an unpaused session;
even read operations cannot claim or group a new start tab. Cleanup can run after Resume.
Permission questions are serialized and shared by live waiters; cancelling the last
waiter retires that question without deleting a fresh request for the same site.

The second adversarial review also closed these paths:

| Finding                                                                           | Repair and regression evidence                                                                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle expiry or a second storage writer could erase a pause                        | Paused sessions survive idle sweeping; panel permission decisions go through the worker's shared stores and a serialized permission queue                               |
| A cancelled release or delayed Stop could overwrite newer state                   | Queued state mutations check cancellation; control persistence and cleanup stay ordered, while a trusted Stop/Take over gates and cancels work immediately              |
| A queued Host operation could outlive revocation, replacement or its caller       | The actual synchronous socket send checks connection identity, authorization revision, pending receiver and remaining deadline                                          |
| Lifecycle, Browser Access or a separate CLI process could bypass the grant setter | In-process mutations retire old connections; a unique persisted authorization audit ID detects cross-process revoke/regrant and suspend/resume, even in the same second |
| Waiting for a database writer could consume the deadline or cancellation          | A SQLite IMMEDIATE transaction fences the send against authorization writers; time and receiver closure are checked again inside that boundary                          |
| Slow native APIs could continue after the operation budget                        | Socket timers, runtime deadlines and checks between native phases prevent subsequent calls and late success                                                             |

Authorization changes close the old connection with code 1008. Reconnecting
negotiates a fresh connection; a rapid regrant never revives queued work on the old
one. Page content cannot answer or forget site permissions: the worker accepts
those messages only from its own side panel. Pauses remain in session storage
until explicit Resume or browser-session reset.

## Compatibility contract

`packages/companion-client/src/browser-agent-protocol.json` exports envelope v1,
the `agent-safe-v1` profile, the operation vocabulary and overlay ABI 1. Extension
tests consume the exported fixture instead of reading Rust source. Rust tests pin
the Host to the same fixture, and an actual injected-overlay test pins its ABI.

| Host                | Extension | Agent behavior                                                              |
| ------------------- | --------- | --------------------------------------------------------------------------- |
| Updated             | Updated   | Drive grant, local agent mode, matching profile and overlay ABI required    |
| Legacy              | Updated   | Status-only device socket; HTTP capture remains available                   |
| Updated             | Legacy    | Host refuses operations before inserting a pending call or queueing a frame |
| Unknown envelope    | Updated   | Stable incompatible state; explicit reconnect required                      |
| Unknown overlay ABI | Updated   | Page action refused; reload/update required                                 |

The browser client uses legal application close code 4002 for incompatible envelopes.
The Host maps incompatible operations to HTTP 412, non-retryable. Status hints and
HTTP pairing/capture keep their existing identities and envelope conventions.

## Verification

The evidence ledger records failing regressions, final commands and review results:
[revocation/protocol ledger](../evidence/2026-10-23-browser-companion-revocation-protocol.md).

Chromium safety specs run the production MV3 worker, a real device WebSocket,
production runtime, injected overlay and Chrome APIs. The deterministic Host fixture
validates ticket-request authentication, origin binding and single-use tickets. It
does not run the Rust server. The test profile pre-grants only loopback access and
seeds the agent preference to avoid an unautomatable browser permission prompt;
per-site approval still goes through the panel. The shipped manifest remains
separately tested without pre-granted host access.

The second review ran three bounded reviewer cycles and reproduced findings with
failing behavioral tests before repairing them. The final extension/overlay run
passed **663 tests across 57 suites**, and Chromium passed **38 E2E tests**. The
Rust socket suite passed **18 tests**, including a real loopback WebSocket and an
external SQLite writer/caller-cancellation race. The security crate passed **237
tests**, including two independent file-backed connections observing same-second
authorization changes. The wider companion run passed 778 tests and failed one
unrelated `TaskDeliveryRecord` schema assertion; it is not a passing full-crate gate.
The final ledger records full-repository typecheck limitations separately.

The extension impact classifier now includes shared overlay/engine, browser-companion,
Rust companion/security and desktop companion API changes. A future Host-only change
therefore selects the extension verification lane.

## Remaining work before extracting the repository

No repository was moved and no package was published. The extension and shared
packages remain private workspace packages. The following release/dependency work
must be completed when extraction is authorized:

1. Publish or deliberately vendor pinned `@cognia/companion-client` and
   `@cognia/plugin-ui` artifacts. Replace `workspace:*` only after a clean consumer
   install proves the chosen artifacts contain the required exports and styles.
2. Remove checkout-relative coupling in `browser-extension/wxt.config.ts`,
   `browser-extension/tsconfig.json` and the Tailwind `@source` path in
   `browser-extension/src/styles/tokens.css`. Package the actual overlay bytes
   with their ABI instead of retaining the `../lib/browser/overlay.injected.js` alias.
3. Move the Jest/WXT/Playwright harness and build commands with the extension.
   Keep Host-side contract checks and cross-repository consumer CI in the main repo.
4. Exercise installed-profile upgrades and the actual packaged desktop/headless
   Host together, including revocation and reconnect. These were not established
   by the deterministic Host/browser harness.

The in-repo safety and compatibility gates are now explicit. Extraction readiness
still requires the clean-consumer and real-Host release checks above.
