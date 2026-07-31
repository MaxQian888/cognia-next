---
title: ADR-0085 — Cloud/headless shared browser
description: "Add a persistent per-workspace runtime and a product-owned RemoteChromiumEngine while preserving the Tauri EmbeddedEngine. Agents act through structured snapshots and opaque refs; people observe and take over through a ticket-authenticated media gateway."
---

# ADR-0085 — Cloud/headless shared browser

**Status**: Accepted, experimental and default-off (2026-07-18)
**Builds on**: ADR-0055, ADR-0059, ADR-0065, ADR-0072, ADR-0073

## Context

The embedded Tauri browser gives desktop users a useful shared Agent/human surface, but it does not exist in cloud, mobile-companion, or headless deployments. The existing T2 runner is also the wrong lifetime: each external Agent is PID 1 of a disposable container, so a browser, dev server, and successive Agent processes cannot share one durable workspace boundary.

Importing Aiden/Lynx rooms, exposing Playwright/CDP, or treating Playwright MCP as the product backend would couple Cognia to another product's protocol and leak a privileged endpoint to clients.

## Decision

### Persistent workspace runtime

Add `WorkspaceRuntimeBackend` beside the existing `LocalProcessBackend`, `ContainerBackend`, and Kubernetes backend. A workspace is migrated only when listed in `COGNIA_WORKSPACE_RUNTIME_WORKSPACES`; all other workspaces retain the previous backend.

The new image pins Playwright/Chromium 1.61.1. Its Node supervisor becomes PID 1 after a root entrypoint fixes the mounted workspace/profile ownership, then runs as `pwuser`. It hosts multiple sequential or concurrent external-Agent children and the browser service. It receives exactly one workspace mount, no host filesystem, no privileged mode, and no raw Docker socket.

`cognia-server` locates a workspace runtime through a private URL template plus a per-runtime secret file. The private v1 protocol exposes health, control, Agent events, and latest-frame media. Runtime, Playwright, and CDP endpoints are never returned to a client.

### Browser session and engine contract

One parent chat session owns one `BrowserSession`; team child sessions reuse the parent's binding. A remote session owns one Playwright `BrowserContext`, up to eight pages, and one global active page. Named profiles are workspace-scoped and exclusive; ephemeral contexts are the default.

The existing `BrowserEngine` remains the model-facing contract and gains page, file, and download operations. `EmbeddedEngine` remains the desktop localhost default. `RemoteChromiumEngine` is a Companion-RPC adapter; the actual Playwright implementation lives inside WorkspaceRuntime. Existing `browser_*` names stay stable, with `browser_pages`, `browser_switch_page`, `browser_close_page`, `browser_set_files`, and `browser_downloads` added.

Snapshot refs are opaque. Runtime state binds each ref to `{browserSessionId, pageId, generation}` and rejects cross-page, cross-session, post-navigation, and post-restart use with `browser_stale_ref`. The shared injected DOM script preserves accessibility, layout, React component/source, and annotation signals across embedded and Playwright frame execution contexts.

### Gateway, media, and control

All public traffic terminates at `cognia-server`. A device/OIDC JWT may request a random 60-second, single-use stream ticket bound to account, device, and BrowserSession. The browser WebSocket accepts only that ticket; long-lived JWTs never appear in its URL.

Control uses a v1 JSON envelope. JPEG frames use a fixed 24-byte binary header carrying protocol, codec, sequence, size, timestamp, and payload length. WorkspaceRuntime keeps at most one unacknowledged CDP frame. The server acknowledges receipt immediately and stores only the latest frame in a watch channel, so slow viewers cannot accumulate a queue.

Many viewers may observe; one writer holds a server-authoritative epoch lease. Agent mutations receive at most 15 seconds. Human takeover increments the epoch immediately and invalidates the Agent's pending input. Human control expires after 30 seconds without input, with a five-second disconnect grace. Snapshot/console/network reads need no write lease.

### Security and lifecycle

Runtime loopback is allowed for the workspace dev server. Public top-level origins require a session or workspace grant. Other RFC1918, carrier-grade NAT, link-local, ULA, multicast, cloud metadata, and rebinding answers are always rejected. Granted DNS names are resolved, validated, and passed to Chromium as pinned host-resolver rules.

Uploads accept at most ten relative workspace paths, validate realpath/symlink containment, and cap each file at 100 MiB. Downloads enter a 0600 quarantine (250 MiB each, 1 GiB/session) and reach the workspace or chat only after explicit user action. Password, OTP, token, and secret fields are removed from snapshots and logs. Frames are not persisted; screenshots, traces, and recordings require an explicit user action.

The shipped quotas are three active BrowserSessions per workspace, eight pages and five viewers per session, 30 minutes idle, and eight hours absolute lifetime. Runtime crashes invalidate ephemeral sessions; a named profile may be restored into a new session.

The capability is hard-gated by `COGNIA_REMOTE_BROWSER_ENABLED=false` by default, the user's experimental setting, an installed runtime image, and a successful runtime health probe. Active sessions never migrate backend automatically.

## Consequences

- Desktop localhost remains zero-infrastructure and backward compatible.
- Cloud/mobile/headless gain the same structured Agent tools and a human-visible surface without receiving privileged endpoints.
- The persistent runtime is a larger, longer-lived isolation boundary and therefore needs explicit resource limits, image patching, health monitoring, and workspace-scoped rollout.
- Chromium is the only v1 producer. The gateway contract does not encode CDP, so a future WebRTC or non-Chromium producer can be added without changing client semantics.

## Rejected alternatives

- Copy Aiden/Lynx room and message protocols.
- Publish Playwright or raw CDP endpoints to clients.
- Use Playwright MCP as the product backend.
- Replace `EmbeddedEngine` or delete the existing disposable runner in the same release.
- Persist continuous frames, credentials, or browser traces by default.
