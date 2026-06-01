---
title: Plugin Signing
description: Generate a publisher keypair, sign a plugin, and configure the official trusted key.
---

# Plugin Signing

Cognia verifies an **Ed25519 detached signature** before promoting a plugin
install. Signing is enforced by the **Settings → Plugins → Policy** panel:

- **Require signed plugins** (`signatureRequired`, default **on**) — an
  unsigned plugin is rejected at install.
- **Trusted publishers only** (`trustedPublishersOnly`, default off) — a valid
  signature is accepted only from the official key or a publisher you trust;
  unknown signers are rejected.

## The official key is injected at build time

The official publisher public key is **not** committed to the repo. It is read
from the `NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY` environment variable at build time
(`lib/plugin/security/signature.ts → OFFICIAL_PLUGIN_PUBLIC_KEY`). When the
variable is unset:

- `isOfficialPublisherKeyConfigured()` returns `false`,
- **no** official publisher is seeded (so an empty-key signature can never spoof
  the official anchor), and
- `trustedPublishersOnly` rejects everything until a real key is configured.

To ship signed first-party plugins, set the variable to your base64 Ed25519
public key before `pnpm build`:

```bash
NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY="<base64-public-key>" pnpm build
```

Keep the **private** key out of the repo and out of CI logs — only the public
key is ever embedded.

## Generate a keypair

The keypair generator runs in the Tauri backend (`plugin_generate_keypair`),
surfaced in the renderer via:

```ts
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"

const { publicKey, privateKey } = await getPluginSignatureVerifier().generateKeyPair()
// Store `privateKey` in your password manager / CI secret store.
// Use `publicKey` as NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY (and as the
// `author.publicKey` other users add to their trusted-publishers list).
```

## Sign a plugin

```ts
const signature = await getPluginSignatureVerifier().signPlugin(pluginPath, privateKey, {
  algorithm: "ed25519",
})
```

This writes the detached signature alongside the plugin bundle. The Rust side
(`plugin_create_signature` / `plugin_verify_detached_signature`) performs the
actual cryptography; round-trip tests live in
`src-tauri/src/plugin_api/signature.rs`.

## Adding a community publisher

Users can trust additional publishers without rebuilding: the verifier persists
user-added publishers (`addTrustedPublisher`) keyed by their public key. With
**Trusted publishers only** on, only the official key plus these user-added keys
are accepted.
