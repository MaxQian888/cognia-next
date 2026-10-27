# Lume sandbox development and qualification

The integration is local to an unlocked Cognia account in the Apple Silicon
Tauri app. Lume is disabled until explicitly configured. Legacy connection rows,
imported endpoint addresses and renderer readiness flags grant no native authority.
The native ownership journal and SSH secrets belong to the local account.

Use the [technical plan](../plans/2026-10-23-lume-sandbox-integration.md) for the
threat model and A1–A18 release acceptance. The [evidence ledger](../evidence/2026-10-23-lume-sandbox-integration.md)
records checks actually run. Real guest acceptance is pending; unit tests do
not qualify an image or Driver release.

## Host preparation

Install Lume **0.6.1** separately from Cognia and verify its provenance. Cognia
hashes the selected executable, checks its version, and refuses a changed binary.
It never downloads a recovery image or upgrades Lume automatically.

Open Settings → Automation → Sandboxes → Lume virtual machines. Configure the
absolute executable path. Create from a local IPSW, clone a stopped seed using
its explicit storage directory, or adopt an otherwise unowned `cognia-*` VM
already in this account's Cognia-owned storage. External VMs must be cloned.
Provisioning requires at least 60 GiB available; allocate additional space for
the IPSW, guest writes and build output. No Host directory is mounted in the VM.

The native journal is under the platform local-data directory at
`cognia/lume/<sha256(localAccountId)>/journal.json`; sibling `vms/` is the owned
Lume storage. Do not edit or copy this journal between hosts or accounts.
Unknown versions and incomplete operations fail closed. Preserve the disk and
use Stop to reconcile an interrupted operation before deletion.

## Guest helper artifact

Build the Darwin helper from the same Cognia revision on an Apple Silicon Mac:

```sh
cargo build --locked --release -p cognia-desktop-guest --bin cognia-lume-guest --target aarch64-apple-darwin
shasum -a 256 target/aarch64-apple-darwin/release/cognia-lume-guest
```

Transfer that binary using the guest's trusted preparation console or another
operator-approved channel. Install it root-owned and non-writable by the guest
account at `/usr/local/libexec/cognia-lume-guest`. Record its SHA-256 and source
revision. Cognia does not redistribute an Apple IPSW or a Cua Driver app.

Select **Prepare SSH identity** before setup. It returns only a client public
key, a per-resource nonce and fixed guest paths; the private key stays in the
Host secret store. Configure a dedicated guest user, an empty workspace such as
`/Users/lume/CogniaWorkspace`, and a mode-0600 file
`~/.config/cognia-lume/guest.json`:

```json
{
  "instanceNonce": "the nonce returned by this resource",
  "workspaceRoot": "/Users/lume/CogniaWorkspace"
}
```

Install the returned public key in that user's mode-0600 `authorized_keys` with
this prefix, followed by the public key on the same line:

```text
restrict,command="/usr/local/libexec/cognia-lume-guest ssh-ingress" ssh-ed25519 ...
```

`ssh-ingress` accepts exactly the fixed helper command and
`/usr/local/bin/cua-driver mcp`; all other original commands are refused without
shell interpretation. Disable password SSH and interactive login for this key.
For every clone, regenerate the guest SSH host keys and install the new client
key and nonce. Display the guest's ed25519 public host key in its trusted
console; compare the native consent fingerprint before selecting **Verify and
trust SSH key**. There is no trust-on-first-use or host-key bypass.
Ed25519 host keys are validated and stored in canonical form. Formatting
differences do not permit two clones to reuse the same host key. Cancelling
preparation or qualification reaches the subprocess and is checked again
before credentials or readiness are committed.

## GUI preparation

**Clear clipboard and open setup** requires separate native consent. In Lume
0.6.1 the native window synchronizes the clipboard in both directions; do not
copy Host secrets during preparation. Automated Shell, file and GUI operations
are blocked during this mode. **Stop now** closes the VM and preparation channel.
Setup also stops after 15 minutes or when the foreground VM process exits.

Install a specifically approved, signed `/Applications/CuaDriver.app` and expose
its installed CLI at `/usr/local/bin/cua-driver`. Grant its macOS privacy
permissions in the guest console. The read-only permission probe must attribute
Accessibility and Screen Recording to `driver-daemon`. See the upstream
[Driver setup and CLI reference](https://cua.ai/docs/cua-driver/reference/cli/serve-and-configure).

This dedicated automation guest requires an unlocked graphical console owned
by the SSH user after cold boot, matching autologin, and guest FileVault off.
Configure these explicitly in the guest; Cognia never logs in or changes these
settings over SSH. Install the user LaunchAgent
`~/Library/LaunchAgents/com.cognia.lume.driver.plist` with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.cognia.lume.driver</string>
  <key>RunAtLoad</key><true/>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/open</string><string>-a</string>
    <string>/Applications/CuaDriver.app</string>
  </array>
</dict></plist>
```

Stop setup, start headless, enter the helper hash and approved Driver version,
then select **Verify guest channels**. GUI readiness additionally requires the
live console/permissions profile, MCP negotiation and a decodable capture.
The required tool-schema fingerprint is pinned. Input rechecks the live profile
and native admission immediately before dispatch. Clipboard, arbitrary MCP
scripts and held-button/key operations are unavailable.
Failed helper/VM inspection and failed live GUI profile checks revoke the old
qualification. Successful Shell health checks preserve the existing frozen
binding; a failed GUI probe leaves Shell usable only when helper qualification
succeeds. The approved schema pin survives failed probes. A changed Driver
schema is never accepted merely because a previous check failed.

Qualification also pins the approved Driver executable SHA-256, Developer ID
team/designated requirement and CDHash, plus the daemon PID/UID. The CLI must
resolve into the installed app. The guest checks the Unix socket peer through
the kernel and verifies its running code with Security.framework. Native
consent presents this identity. The bounded SSH MCP relay removes the private
identity field from initialization and rechecks it before forwarding every
request. Artifact changes require fresh preparation; daemon changes within one
boot revoke GUI readiness. A cold boot may requalify a new daemon PID for the
same approved artifact.

Runtime frames undergo the same bounded image and RGBA budget checks before
the Driver session reports success. Malformed replies, response-order errors
and timeouts close the MCP session; dropped calls cannot reuse an unsettled
response. Unknown GUI effects require quarantine and Stop.

## Workspace and control behavior

Before selecting the VM for a task, enter its selected Host workspace directory
in Lume settings and choose **Import workspace replica**. Native consent names
the source root. Task Workspace captures the real `wsrev1` source revision;
the Host imports a bounded, hashed replica into an empty guest workspace. The
canonical source path and directory device/inode identity are pinned; replacing
the source root invalidates binding and adoption even if its bytes match. No
Host directory is mounted. Credentials, environment files, Git metadata and
common dependency/build trees are excluded. Symlinks, hardlinks, path collisions
and oversized input refuse the import. The current replica profile permits
512 files and 8 MiB total; larger projects need a smaller selected root.

A session freezes one native binding for Shell, typed files and GUI. The native
Host compares its canonical workspace root with the imported source, rather
than trusting a renderer-provided revision. Text edits use hash CAS; binary
uploads use no-clobber publication under `/workspace` in the existing viewer.

Choose **Review guest changes** to export a bounded replica and inspect the
immutable text patch. **Approve and adopt reviewed changes** asks native consent
for the source root, file count and patch digest, confirms VM Stop, then uses
Task Workspace's existing compare-and-swap apply. A changed Host source revision
refuses the whole patch without writes. Deletions are included. Adoption never
re-exports or silently applies a newer guest diff. Text patches are limited to
64 files, 256 KiB per file and 1 MiB total; binary or executable-mode changes
require explicit download/manual handling. Successful adoption retires this
replica; use a new clone for subsequent source work. No files are published
merely by executing a command or releasing a session. If publication commits but
the subsequent journal write fails, the Host preserves the applied receipt and
quarantines further work for recovery.

The new Lume workspace module owns transport orchestration only. The explicitly
allowed automation → task-workspace dependency reuses the source revision,
confined-read and CAS authority. Its bounded capture profile caps reads before
allocation and disables repository fsmonitor/hooks during Git inspection.

The VM belongs permanently to one execution group after binding; provision a
fresh clone for another group. Native account locking revokes queued sends and
bindings. The existing desktop control domain serializes human input, Agent
actions, exec and typed file mutations. A viewer must acquire control; stale
frames, leases, bindings and boot epochs are rejected.

The Host generates the group identity and admits one session through one-shot
native consent; supplying a group name grants no membership. Bindings carry
the session identity, expire after 15 seconds and renew every 5 seconds only
while the renderer owns the active session. Closing a session stops renewal
immediately, even during pending rebind consent. The native watchdog revokes
expired bindings and confirms Stop when their last session retires. Transient
qualification readiness does not prevent renewal; account/epoch revocation
and quarantine still do. Disabling Lume revokes execution immediately while
retaining the native watchdog's cleanup responsibility; a failed Stop leaves
durable quarantine for recovery. A stale cleanup cannot cancel work admitted
for a newer boot. Old journal bindings are discarded before decoding so
owned-VM recovery remains available after upgrade.

VM-wide network-off/allowlist and strict CPU limits are refused. A requested
memory ceiling must cover the entire inspected VM. Narrow arbitrary-exec read
scopes remain unqualified. Typed files have no arbitrary program or network
entrypoint. Normal command completion retains the same exclusive execution
group and may leave background jobs running; it does not attest descendant
cleanup. Further Shell, typed-file reads and GUI Agent calls use that same frozen
binding. Typed writes and uploads refuse after Shell or GUI input could leave
asynchronous writers. Use a fresh clean clone before typed writes or uploads
again: Stop cannot attest the absence of startup jobs on the next boot, and
advisory file locks cannot provide CAS against those writers. Reads, Shell and
GUI remain available to the same group. Guest
publication/fsync errors require Stop rather than being treated as harmless
validation refusals. Human control after Shell work requires a confirmed Stop and fresh
connection/qualification. Timeout, cancellation, transport uncertainty and
group retirement require VM Stop; failed cleanup remains quarantined. Commands
are never automatically replayed after a reboot.

The implemented framing caps are 256 KiB for JSON headers and 8 MiB for binary
payloads. Exec stdout/stderr are each truncated to 16 KiB on UTF-8 boundaries,
with independent truncation flags, so worst-case JSON escaping fits the header.
These are the current implementation limits, not the plan's proposed budgets.

## Verification and recovery

Settings shows the current native operation stage and a **Cancel operation**
control. Cancelling requests native cleanup and keeps the operation pending
until the Host returns a terminal receipt. **Stop now** remains available
during foreground work. Leaving Settings also requests cancellation; it does
not establish that the VM has stopped.

If an operation finishes before cancellation takes effect, its successful
receipt remains authoritative. An applied source adoption is never reported
as undone. A recovery warning on that receipt means files were applied but
native ownership bookkeeping requires inspection and Stop/requalification.
Do not repeat adoption to clear that warning. Capacity, version, SSH trust,
guest readiness and source drift failures show translated next actions rather
than raw command output. If operation observation is lost, inspect the current
VM state and confirm Stop before retrying a mutation.

Run focused Jest suites through `pnpm test`, guest protocol tests with
`cargo test --locked -p cognia-desktop-guest --lib lume`, and native tests with
`cargo test --locked -p cognia-automation --lib cua_sandbox::lume`. Check bounded
source handoff with `cargo test --locked -p cognia-task-workspace --lib bounded_`. Compile the
Tauri seam with `cargo check --locked -p cognia-automation --lib --features tauri-host`.

With an authenticated, unlocked agent-debug shell already running, execute:

```sh
node scripts/smoke/lume-sandbox.mjs
node scripts/smoke/lume-sandbox.mjs --resource-id OWNED_RESOURCE_ID
```

The first checks real IPC/versioning and unknown-operation refusal without a
VM. The optional resource argument captures an already qualified guest and
records dimensions/hash only. It never provisions, starts, injects input or
deletes. Reports default to `.cache/lume-sandbox/native-smoke.json`. Use a
disposable guest and the plan's A1–A18 matrix for actual lifecycle, hostile
process, clipboard sentinel, coordinate, takeover and cold-boot acceptance.

On uncertainty, stop admission and use **Stop now**, inspect the retained disk
and operation state, then requalify. Stop still attempts the verified owned VM
when journal writes fail; a stopped VM with a journal error stays quarantined.
Do not delete a resource to hide incomplete cleanup or automatically replay a
failed mutation. Feature-off preserves inspect/stop/delete recovery.

Creation/deletion recovery uses the native operation intent and an actual
absent-path check. An interrupted create with no VM directory can be retired;
a delete that removed its owned directory can still be acknowledged if the
CLI response was lost. A partial directory or dangling symlink is retained
for inspection. Stop cannot confirm absence while a lifecycle child still
owns the writer; wait for its terminal result and retry Stop. A credential
cleanup warning on a retired resource can be retried after unlocking the
account's secret store. These checks never adopt partial disks automatically.
