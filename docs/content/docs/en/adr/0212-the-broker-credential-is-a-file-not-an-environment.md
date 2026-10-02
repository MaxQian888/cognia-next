---
title: "0212 — The broker credential is a file, not an environment variable"
description: "The managed code-server broker no longer puts its secret in code-server's environment, where every terminal, task and language server inherited it. The host writes a single-use bootstrap credential to a private file whose path is the only thing in the environment; the extension reads and unlinks it, and both sides derive a rotating session key from the handshake nonces so the key never crosses the wire. A bootstrap presented twice while its first user is connected trips the instance. The retired newline protocol is gone and the protocol major is negotiated."
---

# ADR 0212 — The broker credential is a file, not an environment variable

**Status:** Accepted
**Date:** 2026-10-02
**Related:** [ADR-0088](./0088-pro-ide-code-server) (Pro IDE and the managed broker), [ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked) (where the Rust lives)

## Context

The managed code-server profile loads Cognia's broker extension, which dials a
loopback JSON-RPC channel in the app (`crates/cognia-codeserver/src/agent_channel.rs`)
and lets the app and the agent drive the editor. It authenticated with a
per-instance `tokenId.secret` that the host placed in code-server's environment as
`COGNIA_CS_AGENT_TOKEN`.

code-server hands its environment to every process it starts: integrated
terminals, tasks, language servers, debug adapters. So the secret was readable by
any command the user or an agent ran in the workbench (`env | grep COGNIA`). The
channel let the newest authenticated connection replace the previous one, so
anything holding the secret could take over the editor channel, inject
`chatContextRequested` events into the chat composer, and call the content-handle
endpoint, which accepted the raw secret as a bearer and compared it with `==`.

Two smaller problems sat next to it. The retired newline protocol was still
accepted (and sniffed from the first bytes), one release after it was meant to
go. And the bundled broker `.vsix` was reinstalled only when its version string
changed, with no integrity check on the file.

## Decision

### 1. The environment carries a path, not a secret

The host writes a **bootstrap credential** (`{ tokenId, secret }`) to a file in a
per-user `0700` directory **outside** the code-server user-data dir (profile
synchronization copies user-data trees between profiles), created
`O_EXCL | O_NOFOLLOW` at `0600`. The child environment gets
`COGNIA_CS_AGENT_CREDENTIAL_FILE`, the agent and content ports, the host id and
the workspace, and nothing secret. The extension reads the file and unlinks it.

### 2. A bootstrap is single use; sessions are derived and rotate

The challenge carries a client nonce; the host answers with a server nonce; the
hello proves possession with `HMAC(secret, server nonce)`. A successful hello
consumes the bootstrap, and both sides compute
`session = HKDF-SHA256(secret, "cognia-broker-session" ‖ server nonce ‖ client nonce)`.
The session key never crosses the wire. The hello reply names a `sessionId`;
reconnects present it and prove the key, and every successful hello rotates the
session again. The content endpoint's bearer is
`sessionId.HMAC(session, "content")`, compared in constant time.

### 3. The host keeps a credential available

Whenever an instance has no live authenticated connection, the host re-mints the
bootstrap file: when the connection drops, before it restarts the extension host
itself, and on a maintenance tick when the file has vanished (an extension host
that crashed after reading it). This covers extension-host restarts the host did
not drive, such as a browser reload.

### 4. Replay is a tripwire

A bootstrap presented again **while the connection that consumed it is still
connected** means two parties read the file. The host closes every connection for
that root, revokes the session, mints a fresh bootstrap, records
`credential-replayed` and emits `codeserver://broker-security-event`; the pane
warns the user. A consumed bootstrap whose consumer is gone is simply refused.

### 5. One framing, negotiated majors

The broker speaks only JSON-RPC with `Content-Length` framing. Anything else is
answered with `IDE_BROKER_PROTOCOL_INCOMPATIBLE` and closed. The hello offers
every version the extension speaks and the host answers with the highest major
both share (`negotiate_protocol` in `broker_protocol.rs`); minor differences are
carried by capabilities. A hello with no shared major is refused and recorded as
`protocol-incompatible` for the IDE status.

### 6. The broker build is verified before it is installed

`build.mjs` writes `cognia-managed-broker.vsix.sha256` beside the deterministic
archive. Both hosts verify the bundled file against it before installing, key the
install marker on `version+digest`, and on any failure start the workbench without
the broker and record `install-failed` rather than logging a warning nobody reads.
`pnpm audit:pro-ide-constants` fails if the build stops writing the digest or a
bundle (Tauri resources, the server image) stops shipping it.

## What this does not defend against

Code running as the same OS user can read a `0600` file before the extension does,
or read the session key out of the extension host's memory (for example through
the Node inspector). Decision 4 turns the first into a visible event; neither is
prevented. The goal is to stop the secret leaking by inheritance (environments,
logs, crash dumps), not to sandbox the user from processes they started.

The credential directory is POSIX-only. code-server ships no Windows build
(`download.rs`), so no Windows host ever writes one.

## Consequences

- `env` in a Pro IDE terminal shows no broker secret.
- Taking over the editor channel needs the current session key or a bootstrap the
  host minted, and a raced bootstrap is reported.
- The broker extension is `1.2.0`; older builds cannot connect and are replaced by
  the verified reinstall on the next spawn.
- `BrokerIssue` (`protocol-incompatible`, `install-failed`, `credential-replayed`)
  is recorded per root for the IDE status to surface.
