---
title: "0135 — Diagnostic service completion"
description: "Wire the self-hosted diagnostic service to the product: a triage console, consented submission from desktop and mobile, and one upload state machine shared with the CLI."
---

# ADR 0135 — Diagnostic service completion

**Status:** Accepted
**Date:** 2026-08-20

## Context

ADR-0102 specified a self-hosted diagnostic service and `services/diagnostic-server`
implemented most of it: tenant-scoped grants, resumable uploads, server-side
redaction, symbolication, fingerprint grouping, retention, alerts, envelope
encryption with crypto-shredding, and an immutable audit trail. It shipped with
44 tests, a Helm chart, and a compose stack.

Almost none of it was reachable.

- The only client was `cognia crash submit`, which required a `--grant` the CLI
  had no way to obtain.
- `incident_groups` was written by the grouping pipeline and never read back, so
  `status` never left `open` and `assigned_to` was never anything but NULL.
- `tenants.raw_minidump_access_enabled` and `audit_events.actor_id` were never
  read or written by any code path.
- `GrantRole::Viewer` and `Triager` were ranked but required by no route.
- The "OIDC-protected service console" the ADR called for did not exist.
- `/logs` had an Incidents channel whose consent checkboxes were local state
  nothing read, whose description box was uncontrolled and never read, and which
  had no submit button — beneath copy reading "Nothing is uploaded until you
  review the redacted report and explicitly submit it."
- Desktop incidents were hardcoded to `detected` forever, while the same channel
  offered a lifecycle filter (`queued`/`uploading`/`accepted`) that could never
  match. `recordMobileCrashReceipt` existed with no production caller.

Two defects made the data unusable even where the plumbing worked. The CLI
uploaded the whole `.cognia-diagnostic` zip as one `attachment` part; the
service dispatches processing on `x-artifact-kind`, so a zip yields no stack
frames and every submission fingerprinted on module and exception alone.
And incident creation is idempotent on the artifact hash while `DO UPDATE`
leaves `deletion_credential_hash` untouched, so a retry received a freshly
minted credential that could never verify against the stored hash.

## Decision

**The console lives in the app, not in the service.** It is a fourth `/logs`
channel, following `/servers` (ADR-0059): the design system, i18n wiring, and
CSP-safe transport already exist here, and an operator is a Cognia user. It is
a channel rather than a filter on Incidents because the two answer different
questions — Incidents is what *this machine* captured, Service is what a
service accepted from everyone.

**Role-shaped, not error-shaped.** Viewer reads groups and detail; Triager gets
status, assignee and raw artifact reads; Admin gets tenant policy. What an
operator cannot use is not rendered. A grant below Viewer says so explicitly,
because an empty group list reads as "no crashes" and that is a different fact.

**Grant exchange is not intake.** `DIAGNOSTIC_INGEST_ENABLED=false` also 503'd
the grant routes, and grants live 15 minutes — so every route the switch is
documented to keep up became unreachable a quarter of an hour after it flipped,
which is exactly when a deletion request has to be servable. A grant minted
while intake is off still cannot upload, because the routes that accept data
are the ones that are down.

**One upload state machine, two transports.** The sequence, payload shapes,
resume rule and installation proof live in
`cognia_observability::diagnostic_submit` and are shared by the desktop shell
and the CLI. The transport is a *blocking* trait because the two callers
genuinely cannot share one — the CLI keeps tokio out of its binary by design,
the desktop already carries async reqwest — but nothing above the wire is
duplicated.

**Packaging stays native on desktop.** A package can reach a gigabyte, the
WebView cannot read the crash directory, and the desktop CSP would block a
renderer request to a user-configured host anyway. Mobile has no native
packager and uploads the plugin's redacted report as an `events` part instead.

**Every submission is one part per package entry**, declared with the artifact
kind the service dispatches on, so minidumps get symbolicated and event streams
get scanned for the frames grouping needs.

**An installation identity, not a pasted token, is the end-user path.** The
same Ed25519 key signs the package and the installation proof. On mobile that
needs WebCrypto Ed25519, which Capacitor's WebViews only recently gained, so
the capability is *probed* by generating a key rather than assumed — a
capability that lies turns into "the service rejected your crash report".

**Identity sessions stay in the OS keychain**, the rest of the connection in
per-account local state, mirroring the `/servers` split so a database export
can never carry an operator's session.

## Consequences

- `POST /v1/incidents` now returns `created`, and a `deletionCredential` only
  when it actually created the row. Existing clients that read the credential
  unconditionally get `undefined` on a resumed submission, which is the honest
  answer.
- The compose E2E assertion for the kill switch changed shape: it now checks
  that `POST /v1/incidents` is 503 *and* that grant exchange and triage are not.
- Migration `0006_triage_console.sql` is expand-only — four indexes for queries
  that previously had none because nothing ran them.
- A Viewer-or-better grant can read any incident in its tenant; an Uploader
  remains restricted to its own installation, which is what stops one user's app
  from enumerating another's crashes on a shared tenant.
- `lib/network/platform-fetch.ts` is now shared by `server-ops` and
  `diagnostic-service`; the extraction also fixed a latent bug the ops client
  never hit, where a binary request body was stringified by the Capacitor
  bridge.
- The support-report channel registry notifies subscribers, so a channel
  registered from an effect — or later by a plugin — appears without a remount.

## Alternatives considered

**A console served by the service itself.** Rejected: it would need its own
design system, its own i18n, and hand-written vanilla JS outside every gate
this repo runs, to serve an audience that already has the app.

**A full OIDC authorization-code flow in the service.** Rejected for now. The
service verifies an RS256 session against a configured issuer/audience and
delegates acquisition to the operator's IdP — the contract it already had. An
OIDC *client* (discovery, JWKS rotation, callback endpoints, session cookies)
is a subsystem of its own and nothing else in this repo needs one.

**An async transport trait.** Rejected: it would force an async runtime into
the CLI, which deliberately has none.
