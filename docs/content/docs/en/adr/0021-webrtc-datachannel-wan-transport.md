---
title: "ADR-0021: WebRTC DataChannel WAN transport"
description: "The v2-only, end-to-end encrypted signaling and DataChannel transport used between a paired mobile/browser client and a Cognia host."
---

# ADR-0021: WebRTC DataChannel WAN transport

Status: accepted and implemented. The wire protocol is **v2 only**. There is
no v1 compatibility mode, downgrade path, or shared signaling secret.

## Decision

Cognia keeps LAN HTTPS/WebSocket as the first choice. When the paired host is
not healthy on the LAN, the client attempts a reliable, ordered WebRTC
DataChannel named `cognia.v2`. An authenticated HTTPS/WebSocket route remains
the safe fallback for commands whose command metadata permits retry.

The public Worker is the primary rendezvous. The Axum service implements the
same protocol for self-hosting and disaster recovery. Both expose
`/v2/signaling`.

## Pairing material

Pairing creates a `RoomDescriptorV2`:

- version `2`;
- a random 128-bit room nonce;
- desktop and mobile ECDSA P-256 public keys;
- an expiry time;
- `roomId = SHA-256(length-prefixed canonical descriptor fields)`.

The descriptor contains no user identifier or secret. Each role keeps its
private key in the OS keyring, Capacitor SecureStorage, or a non-extractable
WebCrypto key with an encrypted IndexedDB pairing blob.

## Admission and encrypted signaling

The server first sends a five-second random challenge. A client subscribes
with a signature covering the challenge, room, role, session, epoch, issue
time, and ephemeral ECDH public key. A newer valid connection atomically
replaces the old connection for the same role. A room has one active desktop
and one active mobile.

After admission, each side:

1. derives the P-256 ECDH shared secret;
2. derives directional AES-256-GCM keys with HKDF-SHA-256;
3. encrypts SDP/ICE with a unique nonce;
4. signs the complete length-prefixed header and ciphertext with ECDSA P-256;
5. sends through one bounded, serialized signaling queue.

The receiver verifies role, signature, timestamp, epoch, and strictly
increasing sequence before decrypting. A small reorder window handles network
reordering without accepting duplicates. The rendezvous can route and enforce
room ownership, but cannot read or forge SDP/ICE.

## Negotiation and recovery

ICE received before `setRemoteDescription` is retained in order, up to 256
candidates for 30 seconds. Overflow or expiry ends that negotiation epoch.
Async work checks its epoch before mutating peer state.

The recovery ladder is:

- five-second `disconnected` grace;
- ICE restart;
- full peer rebuild if ICE does not recover;
- full-jitter `1/2/4/8/16/30s` reconnect backoff;
- reset only after a sustained healthy connection.

WebSocket connect has an eight-second deadline; challenge and subscribe each
have a five-second deadline. A missing opposite role is `awaiting-peer`, not a
failed connection. Each browser signaling session serializes at most 64 active
or queued outbound operations. Overflow closes only that session and enters the
existing reconnect ladder, so stale work cannot block or write into its
replacement.

## Data and RPC contracts

The DataChannel carries JSON RPC, event replay control, and bounded chunk
frames:

- physical frame: 32 KiB maximum;
- logical message: 1 MiB maximum;
- eight concurrent reassemblies and 4 MiB total reserved memory;
- 15-second assembly/send deadline;
- browser and Rust-sender backpressure at 1 MiB high-water / 256 KiB low-water;
- 32 concurrent RPCs and 128 queued inbound frames per peer.

Each peer accepts exactly one ordered, fully reliable `cognia.v2` main channel.
Unordered, partial-reliable, and duplicate main channels are closed before
callbacks are registered; `cognia.terminal` remains independent.

RPC requests use
`{id, method, params, idempotencyKey, protocolVersion: 2}`. Command behavior
comes from the shared command manifest. HTTPS and RTC share a persistent
24-hour ledger keyed by `(deviceId, method, idempotencyKey)` plus a parameter
digest. A completed result is replayed; different parameters return
`idempotency_conflict`; a pending record left by a crash returns
`idempotency_indeterminate`.

Events use one global sequence, a persistent client cursor, explicit ack, and
24-hour/10,000-frame retention. A missed window produces
`resync_required`; clients must rebuild affected domains from authoritative
snapshot/read RPCs before advancing their cursor.

## Resource and operational boundaries

Axum and Worker enforce bounded frames, token-bucket rate limits, role
cardinality, session replacement, and a 45-second socket lease. Axum uses
bounded peer queues and evicts slow consumers. Worker state lives in
hibernatable WebSocket attachments and is checked by Durable Object alarms.

TURN credentials are short lived, refreshed before expiry, and generation
guarded so an obsolete async result cannot overwrite newer configuration.
BYO STUN/TURN remains additive and credentials stay in secure storage.

Telemetry records bounded dimensions only: protocol version, platform family,
candidate kind, connection/recovery stage, error code, fallback, overflow, and
resync. SDP, ICE, keys, payloads, and full room/device identifiers are never
logged.
