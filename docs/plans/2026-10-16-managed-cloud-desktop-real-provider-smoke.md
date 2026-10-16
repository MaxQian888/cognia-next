# ADR-0228 real-provider smoke record

Date: 2026-10-16. Status: partial live verification; three subsequent full GHCR
verifications passed. Native qualification is now blocked by a metadata-network
boundary mismatch. All E2B smoke resources are cleaned up.

The user explicitly authorized compiling the native operator, preparing the
image/template and running real E2B smoke, with cleanup of billed resources.
Rust tests remain skipped. The dev merge remains paused. Production remains
dormant; this smoke uses a separate Host data directory and identity.

The sections below retain the initial attempts. The final follow-up section
records the current blocker, additional allocations and cleanup.

## Build and image provenance

- Native source: integration commit `7aaa9d5db0d9b840f192eaa893a9e7b2c183f333`
  plus this change's four Rust files described below, including an explicit
  journal-guard dereference in `managed/service.rs`.
  The first build reproduced E0308 at line 422; the corrected operator build
  completed successfully. No Rust tests were run.
- Operator: `cargo build --locked -p cognia-companion-rpc --bin
managed-desktop-operator`, with two jobs, debug symbols/incremental disabled,
  and an isolated target directory. Its help command executes successfully.
  The normal/build feature graph contains neither `test-support` nor
  `test-inmemory` for the secret store.
  The final operator build passed, with SHA-256
  `a6cb2f8c82c767b14832057618b60507608734d6536ca1afc91938d4289c9259`.
- Image source: the exact recipe 3 image files from the integration commit.
  [Image-only workflow run](https://github.com/MaxQian888/cognia-next/actions/runs/38847150671)
  uses temporary branch `codex/managed-desktop-smoke-20261016` at
  `cfca1c413`. Only the existing Images workflow's managed-desktop job is
  selected; unrelated image, server and bundle jobs are skipped. The image
  has a unique SHA tag, without updating a release or latest tag. The run
  completed successfully. Anonymous registry HTTP returned 200 with an exact
  digest match for
  `sha256:694b3de98d68606e9059f742fa376d96d06fa5ce5155eb7ff63b6a4b2f9c56f2`.
  Its AMD64 child manifest is
  `sha256:a4f3e24cb4d49d5a0cc2ffaf4881011094b4fac5d8f2604b6cdf43e6e7ae2270`.

## Runtime scope and cost

- Provider credential authentication: `GET /v2/sandboxes` returned HTTP 200.
  No credential value is retained in this report or source control.
  The native `store-key` command completed successfully with private pipe
  input, using the isolated Host's persistent encrypted store.
- Isolated smoke Host: `managed-desktop-smoke-20261016`. Before any resource
  creation, a provider query scoped to that Host returned zero running or
  paused sandboxes.
- Actual allocation: five native lifecycle attempts plus two diagnostic-only
  desktops, each bounded by a 60-second deadline. No control smoke ran because
  lifecycle qualification did not pass.
- Selected shape: 2 vCPU / 4 GiB. The current public
  [E2B pricing](https://e2b.dev/pricing) is USD 0.1656/hour for that shape:
  at most USD 0.00276 per 60-second desktop, or USD 0.01932 for the seven
  created desktop sessions. This is a conservative compute bound, not a bill.
  Template-build charges and subscriptions are separate; no subscription
  upgrade was performed.
- The API key cannot enumerate team entitlements (`GET /teams`: HTTP 401).
  No actual account tier is claimed. The smoke will use only the published
  minimum supported duration and a stricter 60-second local limit, with the
  account's default placement. No other Host configuration is changed.

## Evidence boundary

The image was published and digest-verified; the account-local template built.
A native attempt observed provider timeout kill. The final diagnostic verified
startup, HTTP edge/guest authentication and the expected protocol identity.
The full native lifecycle receipt, restart/delete-retry proof, authenticated
WebSocket frame, egress probe and exclusive control/takeover remain unqualified.
The final operator invocation failed immutable-image verification during
registry download before paid approval. No verification gate was bypassed.
Frontend task handoff, agent verdict and human approval are separate acceptance
layers and are not established by a native lifecycle smoke alone.

## Live attempt findings

- The account-local template built successfully: template
  `gyr49hxwzcpcmj38g480`, build `269cf579-b1fd-4ee1-b4f3-1938534bf14a`.
- Attempt 1 created `i3rrqjic7q4v4cg0y6ooh`, failed readiness and cleaned up.
  Provider GET returned 404 afterward.
- Attempt 2 created `ixrsjawrarwhwi9cef0ns`. Direct, read-only provider
  observations confirmed `onTimeout: kill`, `autoResume: false`,
  `allowPublicTraffic: false`, `denyOut: ["0.0.0.0/0"]` and disabled internet
  access. Bootstrap refused with `managed_desktop_endpoint_invalid`.
  Native cleanup ran and provider GET returned 404 afterward. No qualification
  was written by either attempt.
- Operator diagnostics now report only policy booleans and preserve a
  lifecycle error code when readiness fails, instead of always returning a
  generic error. A co-located regression was added but remains unrun under
  the user's Rust-test exclusion.
- The [official SDK](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/connectionConfig.ts)
  defaults an omitted/null sandbox domain to `e2b.app`. Cognia previously
  refused that case. Its endpoint/bootstrap handling now uses this fixed
  default and still rejects explicitly empty, foreign or poisoned hosts.
  A regression assertion was added; the operator rebuild passed. Attempt 3
  confirmed that the create response omits the domain and provider detail
  returns null. With the fallback, bootstrap progressed to HTTP health.
- Attempt 3 created `i2tpvfrwwr71uej1dgajz`, failed with
  `managed_desktop_unauthenticated_endpoint`, and was cleaned up. Provider
  GET returned 404 afterward. No qualification was written. A subsequent
  verification-only invocation was interrupted before any paid approval.
- Targeted non-Rust checks passed: four guest authentication tests and seven
  image release-manifest tests. They do not substitute for live ingress or
  lifecycle qualification.
- A later invocation failed image verification during registry download,
  before template/desktop approval. The scoped provider list still returned
  zero running or paused resources. One bounded registry retry follows.
- [E2B private-ingress documentation](https://docs.e2b.dev/network/restrict-public-access)
  specifies HTTP 403 without the per-sandbox traffic token. The operator's
  diagnostic retry records only the numeric status and whether that token
  was supplied; credentials, response bodies and endpoint URLs are omitted.
- The registry retry passed. Attempt 4 created `i8sahcaeuc35vedaze6ee` and
  observed HTTP 403 without the edge token, then HTTP 502 with the edge token
  but without the guest token. The readiness check incorrectly classified
  upstream unavailability as an unauthenticated endpoint. The desktop was
  destroyed and all four provider IDs returned 404.
- Readiness now retries HTTP 502/503/504 within the existing deadline. Those
  statuses are never accepted as auth evidence; successful access, redirects,
  missing routes and unexpected responses still refuse. A co-located Rust
  regression was added but not run, per the user's instruction.
- Static review found that natural TTL expiry could falsely satisfy the
  second desktop's delete-retry qualification. The operator now requires a
  successful provider delete call after fault injection and verified absence
  before the observed provider expiry. A regression makes every real delete
  fail and checks that later native expiry cannot install a receipt. It remains
  unrun under the Rust-test exclusion. The pending invocation was interrupted
  before paid creation to rebuild with this fail-closed qualification check.
- Attempt 5 (`ie0wte8mrwpnu13qwi1uc`) retried upstream 502 responses but never
  became ready. Provider logs recorded desktop process exit code 1 and sandbox
  `kill_reason: timeout`; no receipt was installed. This is an observed native
  timeout kill, but does not establish the remaining lifecycle assertions.
- A separate diagnostic desktop (`is75yfj9akez7usprpdhi`) used the same exact
  template build, private ingress, blocked egress and a 60-second TTL. Its
  bounded startup stream revealed `Permission denied: '.env'`. It was deleted
  (HTTP 204), then GET-confirmed absent (HTTP 404); it cannot install receipts.
  An initial diagnostic preflight used an incorrect build-status URL and
  refused before creating anything.
- The native envd bootstrap now specifies `/home/cua` as its working directory.
  E2B does not inherit the Docker WORKDIR for this process, and the entrypoint
  drops privileges before dependency dotenv discovery. The existing request
  regression now asserts that fixed working directory. The published image
  and template digest remain unchanged.
- The final fixed-cwd diagnostic (`ixb8f2nf69qvlb6d4g6td`) returned HTTP 200
  with the exact protocol/recipe/server identity, 403 without the edge token,
  and 401 with only the edge token. Startup stayed alive until the bounded
  observation stream timed out; that timeout intentionally stopped observation,
  not a qualification assertion. DELETE returned 204 and GET returned 404.
  Nonfatal xterm font, Openbox menu and missing system D-Bus messages were
  observed; visual rendering and interaction remain unverified.

## Final cleanup and retained evidence

At `2026-10-16T04:52:10Z`, all seven resource IDs returned HTTP 404. The scoped
running-plus-paused provider list returned zero entries. The account-local
template was deleted with HTTP 204 and its subsequent GET returned 404.
The isolated Host journal contains zero qualification receipts, and its
provider configuration is now disabled. Production stays dormant; dev merge
is still paused. The shared dev checkout was not changed.

Private evidence and the compiled operator are retained under
`~/.local/share/cognia-smoke/managed-desktop-20261016/`, including the cleanup
record, sanitized diagnostic output, build log and binary hash. Credentials
remain in the isolated Host's encrypted store, outside source control. A scan
of all six owned source/report/changeset files found no supplied API key.

To resume qualification, use a reliable GHCR transfer path, rebuild/register a
fresh account-local template from the same pinned release, and run the native
lifecycle command before control smoke. Fresh quote approval and qualification
must come from the native operator; diagnostic observations cannot be imported
as receipts. No merge or enablement was performed.

## GHCR follow-up and metadata boundary (2026-10-16)

The pinned public manifest returned HTTP 200. Its 11 layers total about 556 MB;
the largest layer is 510,051,848 bytes. Three consecutive native verifier runs
streamed all layers and passed every digest/size check. The historical transfer
failure did not recur, so no exact transport root cause or transport fix is
claimed. The 900-second overall ceiling, per-read timeout, redirect/auth and
SSRF checks remain unchanged. Safe diagnostics now expose only layer ordinal,
expected size, fixed registry error class and numeric status; never signed
redirect URLs, headers, provider bodies or credentials.

Additional native attempts:

| Resource                | Quoted lifetime | Outcome                                                                                 |
| ----------------------- | --------------- | --------------------------------------------------------------------------------------- |
| `imwk4ru7xz8q3al9kp5eq` | 60 s            | Authenticated readiness, then egress probe failed; expired before cleanup inspection    |
| `ixz4qm0x5wo0e8o8dvosc` | 120 s           | Authenticated readiness, then egress probe failed while provider still running; deleted |
| `iw3w58n5kimi88giupwgq` | 120 s           | Safe diagnostics established a metadata HTTP response; qualification refused; deleted   |

The 60-second harness also had insufficient timing margin: 15 seconds are
reserved for provider create admission, observed readiness consumed about
24–31 seconds, and ten sequential egress probes can consume another 20 seconds
before DNS/transport overhead. Native lifecycle and control smoke now request
an explicitly quoted 120 seconds, still subject to config/plan admission.
This is a harness reliability correction, not proof that timing caused the
original egress failure. Production's 60-minute limit is unchanged. The fake
smoke host asserts duration/cost; the negative delete-retry regression explicitly
caps provider lifetime to keep testing natural expiry without successful delete.
Those Rust tests were written/updated but not run.

The final probe completed and reported:

- `metadata` (`169.254.169.254:80`): HTTP response observed.
- `publicIp`, `publicDns`, `private10`, `private172`, `private192`,
  `carrierPrivate`, `linkLocal`, `publicIpv6`, `metadataIpv6`: no response.

This is not a claim that cloud-host credentials were exposed: no metadata body,
token, or credential was requested or retained by this HEAD-only probe. It does
mean that the current all-no-response requirement failed. Provider inspection
still reported deny-all IPv4 egress, private ingress, kill-on-timeout and no
resume. Those fields cannot override the failed observation.

The [E2B envd source](https://github.com/e2b-dev/runtime/blob/main/packages/envd/internal/host/mmds_route_linux.go)
explicitly pins a route for sandbox MMDS at this address. Its
[MMDS client](https://github.com/e2b-dev/runtime/blob/main/packages/envd/internal/host/mmds.go)
uses that endpoint for initialization. An
[open upstream issue](https://github.com/e2b-dev/runtime/issues/3625) reports
reachability even with an explicit /32 deny; the related
[documentation proposal](https://github.com/e2b-dev/runtime/pull/3627) remains
open as of this check. That proposal is not an accepted provider guarantee.
The observed response is consistent with local MMDS, but this probe alone does
not establish the identity or complete isolation contract of that service.

ADR-0228 section 6 requires blocked metadata egress and refusal of required
policies that cannot be implemented. Therefore the existing qualification gate
is retained. No lifecycle or control receipt was installed, and control smoke
was not run because it requires lifecycle qualification. A future resolution
must either establish and test workload-level metadata denial without breaking
envd, or explicitly review an ADR/provider-attestation change that distinguishes
sandbox-local MMDS from cloud-host metadata. Removing the target, accepting an
arbitrary HTTP denial as isolation proof, or manufacturing a receipt is not a
resolution. No such policy change was made here.

The two account-local templates used in this follow-up were
`pqosi4ctww5m9pc7yodw` / build `07c96f1c-667c-43f9-919b-ec5b6718fae1` and
`ilpf54qt59bn9zeapy06` / build `cf12ff73-6547-4efd-ac7e-03804f315e85`.
The three desktops add a conservative maximum of USD 0.01380 in compute at the
quoted rate; the combined ten desktop sessions are bounded by USD 0.03312.
Template-build charges remain separate and these are not invoice amounts.

At `2026-10-16T06:54:26.325Z`, all three new resource IDs returned HTTP 404,
both new templates had DELETE 204 followed by GET 404, and the Host-scoped
running/paused list returned HTTP 200 with zero entries. Both qualification
maps remain empty. The isolated provider is disabled again; production stays
dormant and dev merge stays paused.

Validation: 4 Python guest-auth tests and 7 Node release tests passed. The final
operator compiled and ran its help entrypoint, then executed the diagnostic
provider run above. One intervening build misleadingly exited zero after a
strip-stage ENOSPC warning and left invalid output; that artifact was not used.
The final build uses `cargo rustc ... -- -C strip=none` with debug/incremental
already disabled. Its preserved executable SHA-256 is
`d1113788e5944aa9a2348577cc8203f59b56a273ce3ba5f9b091952308af6805`.
No Rust tests, coverage, full suites, production enablement or dev merge ran.
Only this task's temporary build directory was removed after preserving the
working operator and log. Private evidence includes `ghcr-followup-build.json`,
`ghcr-followup-build.log` and `ghcr-followup-cleanup.json` under the isolated Host.
