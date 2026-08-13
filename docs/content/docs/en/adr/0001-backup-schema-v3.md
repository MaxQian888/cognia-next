---
title: ADR-0001 — Backup schema v3
description: Cognia's full backup format ported to cognia-next, with encryption, integrity, history, and per-domain transfers.
---

# Backup schema v3

| Status     | Accepted                                                                 |
| ---------- | ------------------------------------------------------------------------ |
| Date       | 2026-04-30                                                               |
| Supersedes | The original v1 `ExportEnvelope` shipped in `lib/data/export-schema.ts`. |

## Context

cognia-next started with a minimal v1 export envelope: a flat JSON file with
the user's settings, characters, skills, presets, and (optionally) sessions.
That worked for moving data between two installs in the same week, but it
didn't help users who wanted:

- An on-disk file they could put in a backup tool without leaking their API key.
- Verifiable integrity — "did the file get truncated mid-write?".
- Encryption with either a device-stored key (one-click) or a passphrase
  (portable across devices).
- Reminders + scheduled writes on Tauri so they couldn't forget.
- Per-domain transfers (just my skills, just my MCP servers).
- Imports from other assistants (ChatGPT, Claude.ai, Gemini Takeout).

Cognia (the original product) has solved all of this in a `BackupPackageV3`
schema. cognia-next adopts the same shape, stripped to our domain.

## Decision

### File formats

```
BackupPackageV3                        # plaintext
├── version: "3.0"
├── manifest                           # who / when / where + integrity
│   ├── version: "3.0"
│   ├── schemaVersion: 3
│   ├── traceId
│   ├── exportedAt (ISO 8601)
│   ├── appVersion
│   ├── backend: "web-dexie" | "tauri-dexie"
│   └── integrity: { algorithm: "SHA-256", checksum }
└── payload                            # every Dexie-backed user table
    ├── settings
    ├── characters / skills / skillResources / teams
    ├── promptPresets / mcpServers
    ├── sessions / messages / sessionState
    └── trustedWorkspaces / ttsProviderKeys

EncryptedEnvelopeV1                    # AES-GCM wrap of a serialized v3 plaintext
├── version: "enc-v1"
├── algorithm: "AES-GCM"
├── kdf: PBKDF2-SHA256-600000-Salt16
├── iv: random 12 bytes
├── ciphertext: base64
├── manifest: same as above (minus `integrity`)
└── checksum: SHA-256 of plaintext

DomainExportFile                       # single-table slice
├── version: "cognia-domain-1.0"
├── domain: skills | mcpServers | promptPresets | characters | teams | settingsTheme
├── exportedAt (ISO 8601)
├── appVersion
└── payload (BackupPayloadV3 subset)
```

The migration boundary lives in `lib/data/migrate.ts`. It accepts a v1 file
and lifts the flat fields into a synthetic v3 manifest+payload, so existing
user files keep working forever.

### Encryption modes

The export dialog offers three modes:

1. **Auto-key** (default) — encrypted with a device-stored key (Tauri:
   `@tauri-apps/plugin-store`, web: `localStorage`). One-click, unreadable on
   other devices unless the user also exports the key.
2. **Custom passphrase** — PBKDF2-SHA256 with 600 000 iterations + AES-GCM.
3. **Plaintext** — readable and therefore gated by a separate warning
   confirmation. It never carries retrieval DEKs.

Encrypted backups include canonical retrieval ciphertext and independently
wrap every provisioned retrieval-profile DEK with the same backup key or
passphrase. Lexical segments remain derived and are rebuilt after restore.

The importer detects the encrypted shape, tries the auto-key silently first,
and falls back to a passphrase prompt only if that fails.

### Additive streaming v4 codec (2026-08-06)

Large databases must not be converted into one `BackupPayloadV3` object before
they can be written. The additive v4 codec therefore uses newline-delimited
`header → chunk* → footer` records:

- `buildBackupStream` reads the catalog-bound portable data with a primary-key
  cursor and releases each IndexedDB page after its record is consumed.
- Each chunk has an independent SHA-256 checksum. A constant-size SHA-256 hash
  chain binds the header, chunk order, and required footer without retaining a
  list of chunk hashes.
- Encrypted streams use PBKDF2-SHA256 and independent AES-GCM records. An
  eight-byte random nonce prefix plus the 32-bit record sequence produces a
  unique 12-byte IV; format, trace id, and sequence are authenticated as AAD.
- Decoders enforce record-size, ordering, checksum, footer, KDF, and nonce
  bounds before exposing a verified chunk.

This is an additive format seam. Existing v1/v3 imports remain readable and
the current UI, scheduler, and WebDAV flows continue writing v3 until their
streaming sink and resumable-restore adapters are complete. The v4 codec must
not be routed into those writers before a matching restore path exists.

### Backup history + reminders + auto-schedule

A new Dexie table `backupHistory` (v10) records every successful or failed
export. The history is capped at 50 newest rows. The settings singleton gains:

- `backupReminderDays` (default 7) — soft reminder cadence.
- `backupReminderDismissedAt` — debounces the reminder banner.
- `backupAutoSchedule` — `{ enabled, intervalDays, dirPath, retainCount }`
  for the Tauri-only scheduled-write loop.

The scheduler runs in `BackupSchedulerProvider`, mounted at the app root. It
checks every 30 minutes (and once on mount) whether
`shouldRunScheduledBackup` returns true; if so, it writes an auto-key
encrypted file to `dirPath` and prunes older auto-backups beyond `retainCount`.

### External-format imports

`lib/data/importers/{chatgpt,claude,gemini}-import.ts` each parse a single
third-party export shape into our `ChatSession` + `StoredMessage` rows.
`lib/data/import-registry.ts` dispatches based on a cheap structural sniff.

The dialog is unified — one "Import from another assistant" surface picks
up whichever format the user drops in.

## Consequences

- **v1 user files keep working** thanks to `migrateEnvelope`. The user
  doesn't need to know we changed schema versions.
- **The plaintext format is canonical-key-sorted** (`canonicalStringify`)
  before SHA-256 so the manifest's integrity check is stable across JS
  engines and table-iteration orders.
- **Encryption is opt-in.** Plaintext stays the default because most users
  back up to a folder they already trust (Drive, Dropbox).
- **The schedule is Tauri-only.** Browsers have no way to write to a folder
  silently; web users get the reminder banner instead.
- **`jszip` is lazy-loaded** inside `lib/export/batch/batch-export.ts`. It
  doesn't ship in the main bundle until the user opens the bulk-export dialog.

## File map

| Path                                                    | Purpose                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `lib/data/types.ts`                                     | Type contracts, error classes, `EXPORT_SCHEMA_VERSION`                                  |
| `lib/data/crypto.ts`                                    | `sha256Hex`, `encryptBackupPackage`, `decryptBackupPackage`                             |
| `lib/data/backup-key.ts`                                | Device-stored auto-key + rotation                                                       |
| `lib/data/migrate.ts`                                   | v1 → v3 boundary; integrity check                                                       |
| `lib/data/build-package.ts`                             | Reads Dexie tables → `BackupPackageV3`                                                  |
| `lib/data/build-stream.ts`                              | Reads portable Dexie data as bounded v4 pages                                           |
| `lib/data/stream-format.ts`                             | Encodes/decodes authenticated v4 NDJSON records                                         |
| `lib/data/apply-package.ts`                             | Writes `BackupPackageV3` back, respecting built-ins                                     |
| `lib/data/scheduler.ts`                                 | Pure helpers: `shouldRunScheduledBackup`, `shouldShowReminder`, `pruneScheduledBackups` |
| `lib/data/import-registry.ts`                           | External-format dispatcher                                                              |
| `lib/data/importers/{chatgpt,claude,gemini}-import.ts`  | Per-platform parsers                                                                    |
| `lib/data/domain/index.ts`                              | Per-domain export/import + registry                                                     |
| `lib/db/backup-history.ts`                              | Dexie CRUD for the history table                                                        |
| `lib/export/text/rich-markdown.ts`                      | Markdown / JSON / plain-text formatters                                                 |
| `lib/export/html/{beautiful,animated,syntax-themes}.ts` | HTML exports                                                                            |
| `lib/export/batch/batch-export.ts`                      | Multi-session ZIP                                                                       |
| `lib/export/single/index.ts`                            | Single-session dispatcher                                                               |
| `hooks/data/*`                                          | React-side wiring for each flow                                                         |
| `components/data/*`                                     | Dialogs + shared bits (passphrase input, encryption options, history table)             |
| `components/settings/data/*`                            | Tab shell + the four tabs                                                               |
| `components/providers/backup-scheduler-provider.tsx`    | The scheduler runner                                                                    |

## Verification

- All ≥90% test coverage thresholds enforced via `pnpm test:coverage`.
- 136 tests across `lib/data/**`, `lib/export/**`, `hooks/data/**` exercise
  the round-trip: build → encrypt → migrate → decrypt → apply.
- Manual smoke tests:
  1. Export each encryption mode; re-import the resulting file.
  2. Drop a ChatGPT / Claude / Gemini export; confirm conversations land.
  3. Per-domain row export → reset → re-import; confirm full restore.
  4. Enable scheduled backups in Tauri; advance the clock; confirm a
     `cognia-backup-*.enc.cbk` lands in the chosen folder.
