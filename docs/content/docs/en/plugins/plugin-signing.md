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
// Both keys are hex encoded. Convert the public-key bytes to base64 before
// using them as NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY or author.publicKey.
```

## Sign a metadata-bound artifact

```ts
const signature = await getPluginSignatureVerifier().signPlugin(artifactPath, privateKey, {
  pluginId: "my-plugin",
  version: "1.0.0",
  algorithm: "ed25519",
})
```

Pass an artifact file path and the hex private key. The required plugin ID and
version must match the artifact's metadata. `plugin_create_signature` signs the
SHA-256 digest of `pluginId + ":" + version + ":" + artifactBytes`; its matching
verifier is `plugin_verify_signature`. The returned object includes the plugin
ID, version, hex signature, hex public key, and a `Date` in `signedAt`. It does
not write a signature file. Only Ed25519 is supported; RSA and `expiresIn`
options are rejected before invoking the backend.

## Sign an installable bundle

The installer uses a separate signature over the raw bundle bytes. Use the CLI
with a file containing a base64 private key:

```bash
cognia plugin sign ./my-plugin.zip --key /secure/publisher-private.b64
```

This writes `my-plugin.zip.sig`, a base64 detached signature checked by
`plugin_verify_detached_signature`. A metadata-bound signature from
`signPlugin` cannot replace this file. Rust round-trip tests for both formats
live in `crates/cognia-plugin-runtime/src/signature.rs`.

## Adding a community publisher

Users can trust additional publishers without rebuilding: the verifier persists
user-added publishers (`addTrustedPublisher`) keyed by their public key. With
**Trusted publishers only** on, only the official key plus these user-added keys
are accepted.
