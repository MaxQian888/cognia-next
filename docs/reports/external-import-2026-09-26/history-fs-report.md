# Native history filesystem wiring — 2026-09-26

The desktop history scanner used plugin-fs without permissions for the external vendor history roots. File-backed parser benchmarks did not exercise that desktop authorization boundary. The fix is a dedicated read-only `session_import_fs` Tauri command, used only by the session importer; it grants no plugin-fs global scope and adds no write operations.

## Implementation and scope

The existing Tauri facade (`src-tauri/src/session_import.rs`) derives roots from the native vendor-root resolver and current home. It permits the eleven existing sources' file-based scan roots plus Claude teams/tasks. OpenCode and native Cursor/Cline/Copilot databases retain their existing native readers; Aider remains picker-only. Credential/config siblings outside those history roots are rejected. Paths are literal native paths, so `*`, `?`, and brackets in configured directories have no glob meaning.

The command accepts only the local `main` webview (packaged app origin or the configured loopback development origin), runs I/O with `spawn_blocking`, and has no companion RPC registration. The pure implementation extends the existing agent-state session-import module. It selects the matching lexical root before canonicalization, then checks canonical containment, including symlink targets and existing ancestors of missing paths. Invalid traversal and non-NotFound failures remain errors. Text reads accept JSON/JSONL/Markdown, reject nonregular files before reading (including directories and sockets), and never truncate valid history.

Wire contract:

- Request: `{ operation: "readText" | "readDir" | "stat", path: string }`.
- Text: `{ kind: "text", content: string }`.
- Directory: `{ kind: "directory", entries: [{ name: string, isFile?: boolean }] }`; symlinks/type lookup failures omit the hint so the existing walker performs stat. Invalid entry names/errors do not suppress valid siblings.
- Stat: `{ kind: "stat", exists: boolean, size: number, isFile: boolean }`; only missing paths return `exists: false`.

Dynamic Tauri scoped ACL mutation was investigated and rejected: local Tauri 2.11.5 `ipc/authority.rs` merges scope IDs that `tauri-utils` resolution restarts at zero. The native command avoids scope-ID collision and write-scope expansion. `startup/host_services.rs` is unchanged. The main handler registration and generated all-app command ACL include `session_import_fs`.

## Executed validation

- `rtk cargo test -p cognia-agent-state --release --lib session_import::tests`: **28 passed, 1 existing benchmark ignored**. Includes full large Unicode text, wire shapes, forbidden paths/traversal/extensions, missing versus other I/O errors, confined/outside symlinks, directory entry conversion and nonregular text inputs. Actual output: `history-fs-core-tests.log`.
- `history-fs-shell-verify.py`: **6 passed** (five real shell tests plus an explicit `tauri::VERSION == "2.11.5"` check). It compiles the actual Tauri facade, actual current core source and `#[tauri::command]` macro against cached real dependencies. No Tauri API stubs. Actual hashes/artifacts/output: `history-fs-shell-tests.log`.
- Release library Clippy with `-D warnings`: passed (`history-fs-clippy.log`). Scoped Rustfmt and diff checks passed.

The first invalid-name OS fixture failed because APFS rejects the filename at creation with `EILSEQ`; the actual failure is retained in `history-fs-core-apfs-fixture-red.log`. The production name-conversion test executes on Unix; the actual invalid-name directory fixture is explicitly Linux-only and was **not executed on this macOS host**.

This verifies native I/O, actual command-shell compilation, root/origin predicates and frontend transport tests recorded by the parent report. It is not a full Tauri application build or a real webview IPC/end-to-end desktop scan. The main handler registration assertion is included in `src-tauri/src/lib.rs`; that full application test target was not built here.
