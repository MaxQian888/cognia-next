---
"cognia-next": minor
---

Security: rebuild the plugin binary trust model (removes a prompt-free arbitrary-execution hole)

- **Fixes a live vulnerability.** A plugin-shipped binary (VS Code extension LSP
  server, or a declarative CLI tool) could be spawned via `child_process` with
  **no user prompt** by having its own manifest assert a publisher fingerprint.
  The policy matched that self-asserted string against the `trustedPublishers`
  table using **plain string equality with no cryptography**, and schema v39 had
  seeded that table with nine `"placeholder:*"` fingerprints whose literal values
  live in the repo source. Declaring `"placeholder:microsoft.vscode"` was enough.
  There was no proof of possession anywhere in the chain. The same flaw existed
  for CLI tools via `manifest.author.publicKey`.
- **New model — a user-consent ledger.** Dexie **v109** adds `approvedBinaries`,
  which records that _this user approved these exact bytes (SHA-256) at this
  exact path for this plugin_. A binary is spawned prompt-free only when it is
  inside the plugin's install directory **and** its current hash matches a
  recorded approval. The binary is re-hashed on every evaluation, so any change
  to it — update, swap, or tamper — re-prompts. Approvals never cross plugin
  boundaries and never cover a sibling binary.
- **The placeholder seed is deleted**, and the v109 upgrade hook removes every
  `"placeholder:*"` row from databases that already stored them. Rows a user
  populated themselves are preserved. `openvsx.root` was dropped too — keeping it
  would have made _every_ Open VSX extension's bundled binary auto-spawnable.
- **Deliberate behavior change:** every plugin-shipped binary now prompts on
  first execution. This is intentional. Open VSX signs with a single
  registry-wide key (no per-publisher fingerprint exists to fetch) and
  Microsoft's marketplace ToS forbids non-Microsoft use of its gallery, so there
  is no honest way to pre-establish publisher identity. Prompting is the only
  default we can state truthfully. The Settings → Developer
  `unsignedLspAllowed` escape hatch and the full `automationAuditLog` trail are
  unchanged.
- **Note on scope:** SHA-256 here proves _byte identity against what the user
  approved_. It is not a publisher-identity or malware claim.
- A new CI gate (`pnpm audit:trusted-publishers`, wired into `pnpm check:all`)
  fails the build if a `placeholder:` row ever returns to the seed.
