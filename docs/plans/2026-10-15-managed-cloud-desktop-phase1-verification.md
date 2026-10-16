# ADR-0228 Phase 1 — implementation and verification record

Date: 2026-10-15. Scope: lifecycle/template adapter only. The user approved ADR-0228 and Phase 1; credentials and permission for real E2B smoke have **not** been supplied. No provider resources, images or releases were created or published by this task.

## Implemented paths

- `crates/cognia-e2b/` extracts the existing sandbox-pool HTTP, exact template-build and envd/Connect transport. The code-task consumer retains compatibility shims; delivery and Git handoff files are untouched.
- `crates/cognia-automation/src/cua_sandbox/managed/` owns owner/Host configuration, price/plan bounds, one-use spending authorizations, exact template identity, exclusive durable journal, cleanup/recovery and native qualification. Unknown create/build outcomes never authorize another billed attempt. Cleanup remains operational while provisioning is dormant.
- `crates/cognia-companion-rpc/src/managed_desktops.rs` resolves authenticated account identity and encrypted Host secrets. Native desktop and headless startup install the reconciler. Remote mutations require ADR-0153 admin leases; service/worker principals cannot issue human spending authority.
- `lib/sandbox/e2b-adapter.ts` extends the existing lifecycle seam. Settings and the actual remote Host device console select the owning Host. Remote management does not initialize local Docker UI or route GUI actions to the Host desktop.
- The existing Images workflow owns digest-pinned image publication and `managed-desktop-release.json`. No imaginary release digest is embedded. Runtime guest tokens are injected after create over protected envd, never captured in a template snapshot.
- The native `managed-desktop-operator` binary has no IPC/RPC registration. It requires an explicit paid-smoke flag and typed approval of each quoted operation, and writes qualification only from measured checks. It is a normal binary because Cargo examples activate this package's test-only in-memory secret-store dependency.

## Current dormancy

Normal create requires an enabled configuration, a matching trusted release/template, a current plan/price binding, Host-owned credentials, a fresh human authorization and qualification for that exact configuration. Missing any gate refuses provisioning. Local Docker behavior remains independent.

The initial smoke harness qualifies **egress Off only**. On/Allowlist configurations remain unqualified, with an explicit type/UI/test limitation. A fixed guest probe records only no-response observations for public/private/link-local/metadata targets; it does not claim a timeout proves packet filtering. Provider policy inspection is recorded separately. Region selection is not silently ignored: non-null region configurations refuse until a provider placement contract can enforce them. The account's default placement must still be accepted before smoke.

GUI viewing/control, takeover leases, task delivery, live preview, automatic project acceptance, persistent/suspended desktops and acceptance result storage remain dormant. Phase 3/4 still require the separately owned delivery ledger to merge. No source task is completed or merged.

## Operator procedure — not executed

1. Obtain explicit authorization identifying the user's account/configuration, default region, shape, quote and smoke scope. Stop that Host so the journal's exclusive lock can prove a single lifecycle owner. Keep the same OS user, secret-store environment and build profile as the Host.
2. Install the actual image workflow's release manifest as `managed-desktop-release.json` in the Host's lifecycle data directory. It must match the published digest, recipe `2`, `computer-server-0.3.46`, `0.3.46` and `linux/amd64`. Host verification streams and hashes OCI blobs before requesting a paid template build. A mismatch refuses; no old-template fallback exists.
3. Install `managed-desktops.json` there, with `version: 1` and `providers`. Each provider uses the `ManagedDesktopConfig` contract in `managed/contracts.rs`: authenticated `ownerPrincipalId`, exact `hostId`, unique `id`, positive `revision`/`credentialGeneration`, `enabled`, `region: null`, shape, limits, plan, price, the exact release document, `egress: {"mode":"off"}`, and `isolationMinimum: "vm"`. Plan/price observations require source and expiration, at most 30 days; use actual account facts and actual selected-shape pricing, never the ADR's historical example as a quote. Limits may tighten 2 concurrent / 3,600 seconds / 600 seconds idle, never raise them. `enabled: true` alone does not qualify or start a desktop.
4. Store the user's provider key with the binary's `store-key` subcommand using private non-terminal stdin. Never put the secret in command arguments, config JSON, browser storage or logs. The reference is `managed-desktop:<owner>:<config>:<credentialGeneration>` under the Host's `cognia-managed-desktops` secret service. Rotate the generation and requalify when changing the account credential.
5. Use `smoke` only after separate authorization. The command demands `--authorize-paid-smoke` and a typed `approve <quote-id> <purpose>` for template setup and each desktop. It verifies auth/protocol/frame and network posture, observes native expiry without a reconciler, reopens the journal, and injects one delete transport failure before verifying real deletion. A failure leaves durable cleanup obligations, not a passing receipt. Restart the normal Host afterward so any pending destroy retry continues.

Command shape (documentation only; substitute real authorized paths/IDs):

```text
cargo run -p cognia-companion-rpc --bin managed-desktop-operator -- --help
cargo run -p cognia-companion-rpc --bin managed-desktop-operator -- store-key --host-kind headless --data-dir /absolute/host-data --config owner-e2b
cargo run -p cognia-companion-rpc --bin managed-desktop-operator -- smoke --host-kind headless --data-dir /absolute/host-data --config owner-e2b --authorize-paid-smoke
```

For `headless`, `--data-dir` is the server's configured data directory, and the tool uses that directory's existing headless master key/store. For Tauri, pass its lifecycle journal directory (`app_data_dir/cognia`) and `--host-kind desktop-debug` or `desktop-release`; the tool uses the desktop's global secret-store initialization. `desktop-release` requires a release-profile operator binary. A profile mismatch refuses. Do not build/run with `test-support`, `test-inmemory`, or a dependency graph enabling test secret stores. Do not create a new master key to bypass a missing existing key.

The quoted value is a maximum single-session compute charge, excluding template-build charges and account subscriptions. Provisioning consumes the absolute deadline; it is not a guarantee of a full interactive duration. Concurrent enforcement is per owner/provider on this Host, not account-wide across Hosts.

## Verification evidence and limits

- Shared E2B transport: **23 Rust tests passed** before the final native egress probe and later review fixes. This is a fixture result, not a passing build of the final Rust diff.
- Frontend initial lifecycle regression pass: **12 suites / 166 tests passed**. Follow-up actual remote routing/admin leases/attestations: **5 suites / 65 tests passed**, then **2 final affected suites / 19 tests passed**. Counts overlap; they must not be summed as unique tests.
- Image release: **7 Node tests passed**. Guest authentication/protocol health: **4 Python tests passed**.
- Managed-desktop protocol additions: **3 focused Node tests passed**. Broader two-file protocol check: **75/76 passed**; the failing `Git fetch admits exact SHA acquisition...` schema is unchanged from HEAD and outside this task.
- i18n generated aggregates/ICU check passed. Rust architecture gate passed with its existing advisory app-shell line ceiling; co-located-test gate reported no new gaps. Source review found and addressed remote routing, lease/consent, operator store/profile and example-target problems.
- Final i18n key parity, referenced-key checks and aggregate sorting passed; two unused newly added translation keys were removed. Protocol generation check reports `853 remote commands, 107 classified routes`. Native source formatting passed for the new managed modules, shared E2B modules and operator binary. Added principal/revocation/cross-tenant/worker, dormant install/shutdown and RPC lease-rejection tests remain unrun with the other native checks.
- `command-grammar` has two existing missing-resource failures: `connector.lark.callback` and `task.workspace.session_scratch`. This task does not repair those unrelated catalog entries.
- Final managed-domain/native Rust compilation/tests were **not completed**: shared disk exhaustion produced `No space left on device`; the user explicitly directed skipping that blocked verification. No further Cargo builds/tests were run after that direction. Added native tests and formatting/source review do not substitute for compiling them.
- Full TypeScript checking exhausted heap at both 4 GiB and 8 GiB; no successful full typecheck is claimed. No actual Tauri/browser UI exercise or real E2B smoke is claimed. The earlier docs build reached static export but failed for disk exhaustion; it is not a successful docs build.

Before qualification or integration, rerun the narrow final Rust tests (`cognia-e2b`, `cognia-automation cua_sandbox::managed`, affected sandbox-pool E2B modules and companion dispatch/operator tests), compile the native operator and thin Tauri wiring, resolve typechecking and exercise actual Host routing. Keep D3/D4 provider authorization and smoke separate from these offline checks.

## Source verification

The shared client creates through `/v2/sandboxes`. E2B's current [official API schema](https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/js-sdk/src/api/schema.gen.ts) (checked 2026-10-15) defines V2 system communication as secured; the optional `secure` property belongs to the older V1 request. The implementation requires the returned envd token and protected ingress rather than adding an unsupported V2 field. This documentation check does not replace the pending provider smoke.
