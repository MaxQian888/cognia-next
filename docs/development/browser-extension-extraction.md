# Browser Companion repository ownership

The browser extension is maintained in [cognia-labs/cognia-browser-extension](https://github.com/cognia-labs/cognia-browser-extension), following the standalone website model. Install, develop, test, build and package it from that checkout. The product repository continues to own the Host, portable companion-client source, in-app overlay and protocol compatibility checks.

## Preserved behavior

The extraction retains the full panel, capture modes, attachments, appearance, saved prompts, pairing/device credentials, origin binding, delivery/status handling and agent runtime. It includes the current revocation fixes: urgent Stop/Take over, durable pause until explicit Resume, worker-owned permission writes, operation deadlines, safe protocol negotiation and Host authorization fences across queued sends and separate CLI processes.

The extension declares the `agent-safe-v1` profile over envelope v1 and requires overlay ABI 1. Older peers retain capture/status; driving requires a compatible Host, a drive grant, local agent mode and site permission. Repository ownership does not change runtime identities or broaden install permissions.

## Consumer CI replaces the local workspace

`integrations/browser-companion.json` pins an immutable commit in the organization repository. The product's existing `e2e-browser-extension` job now:

1. Checks out the proposed product source and the pinned extension commit.
2. Runs `scripts/ci/check-browser-companion-contract.mjs` to compare complete recursive portable client inventories and overlay bytes against the extension's vendor snapshot, check the Host safety profile, and verify the 220 product source/dependency inputs recorded in `provenance/host-contract.json`. Additions and removals also fail the check.
3. Installs, checks, builds and tests the standalone extension, including Chromium and the archive content check.

The change classifier includes all Rust paths and manifests, protocol definitions, shared client/overlay/engine, desktop companion API, the pin and the contract checker. These edits keep selecting the consumer lane even though extension source is no longer in this repository.

For a local check, use an explicit checkout:

```sh
node scripts/ci/check-browser-companion-contract.mjs --extension-root /path/to/cognia-browser-extension
```

An intentional protocol or overlay change requires a tested vendor refresh in the extension repository, then a pin update here. Host source, build-script and dependency changes also require compatibility review and a refreshed Host snapshot before updating the pin. This conservative source fence can require refreshes for unrelated Rust changes; it does not establish real-Host E2E behavior. Custom generators must keep their inputs in the checked inventory; external build inputs require an explicit gate extension. Normal extension install/build/test never reads the product checkout or fetches product source. The source snapshot records the product revision, dirty source state and SHA-256 of every imported file; uncommitted hardening is identified rather than attributed to an unrelated published revision.

The archive is created before Chromium tests and compared to that same build afterward. Releases include project/dependency notices and exact-source links. Publication resolves the full tag ref, recovers interrupted drafts and preserves published bytes; differing bytes require a new version.

## Upgrade and rollback

Keep existing browser storage keys, IndexedDB key slots, optional permissions and pairing routes. For unpacked extensions, retain the installation directory and reload: its absolute path determines Chrome's ID. Moving it requires pairing again. Store publishing must keep the existing listing and signing identity; GitHub repository creation does not publish to the stores.

Rollback uses the previous tested archive and immutable consumer pin. Do not restore legacy permissive driving to make versions appear compatible. The fallback remains capture/status-only when safety negotiation fails. Already-dispatched Chrome calls cannot be rolled back.

## Verification and remaining release acceptance

See the [extraction evidence ledger](../evidence/2026-10-23-browser-extension-extraction.md) and the standalone repository's migration report for actual commands and results. Chromium uses real production extension code with a deterministic Host; Rust tests cover actual Host socket and cross-process authorization boundaries separately. Native browser permission bubbles, packaged Host plus installed extension, store identity upgrades and real Edge remain explicit release acceptance items.

The removal is prepared on an isolated `codex/` branch. The shared dirty `dev` checkout is preserved; the migration PR does not include unrelated local work.
