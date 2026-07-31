# Plugin-Author CLI Remediation — `cognia` (2026-07-16)

**Status:** none of this is implemented. Every finding below is a verified defect in the
plugin-author CLI (`crates/cognia-cli/`, 16 subcommands / ~380 KB of command code), its five
bundled templates (`crates/cognia-plugin-template*/`), its manifest linter, or its CI wiring.

**Scope.** `cognia` — the **plugin-author** CLI: scaffold / lint / build / sign / verify /
install / reload / dev / acp. **Not** `cli/` = `@cognia/agent-cli` (`cognia-agent`), the Ink/React
terminal agent TUI, which is a different product with a different audit
(`2026-07-15-tui-audit-remediation.md`, `2026-07-16-tui-parity-and-industry-gaps.md`). Do not
conflate the two — they share a name prefix and nothing else.

**Origin:** a read-only audit across four axes — scaffolding, lint rule coverage, the
build/dev/sign inner loop, and an industry benchmark. The headline is **not** "the CLI is
immature". It is 16 commands with `--json` on every one, schema-versioned payloads, stable dotted
rule IDs, a good toolchain preflight, and **342 tests that all pass**. The headline is:

> **The default happy path is broken end-to-end, and every check that should have caught it is
> structurally incapable of catching it.**

---

## 0. How to use this document

Each work item is self-contained: problem → evidence → fix → verification. Items are independent
unless a **Depends on** line says otherwise. One item, one commit.

### 0.1 Confidence labels — read this before you touch anything

| Label           | Meaning                                                                                                          | What you must do                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **[CONFIRMED]** | The plan author ran the command against the real built binary, or read the file and quoted it. Output is inline. | Trust the _behaviour_. Line numbers drift — re-locate by symbol, not by line.  |
| **[AGENT]**     | A subagent reported it with file:line; not independently re-run by the plan author.                              | **Re-verify before acting.** Especially counts, percentages, and line numbers. |
| **[OPEN]**      | A genuine product/design decision. No correct answer derivable from the code.                                    | **Do not decide it silently.** See §5.                                         |
| **[RETRACTED]** | A subagent fabricated this. It is recorded only so nobody re-derives it from the session log.                    | **Never cite. Re-research from scratch if needed.** See §0.5.                  |

### 0.2 The one thing to understand before you start

There are **three stacked failures**. They are not three symptoms of one cause:

| #     | Wall                                                                                                                                                                                                                                                                                                  | Consequence                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **1** | **The default scaffold path does not work.** `plugin new` defaults to `--kind wasm`; the wasm template's `.gitignore` omits `.cognia/`, and the wizard defaults `--with-keygen` to true. Then `plugin build` — the printed next step — fails on **every real wasm module**.                           | A new author's first two commands leak their Ed25519 private key into git, then fail to build. |
| **2** | **The checks are not checks.** `plugin lint` returns `valid: true`, exit 0 on a manifest containing path traversal, an absolute path, a nonexistent entry point, and invalid base64. The Rust↔TS parity guard has run **0 tests since 2026-07-13**. The CLI's own 342 tests **have never run in CI**. | Nothing can catch wall 1. Nothing did.                                                         |
| **3** | **The scaffold models the wrong world.** Templates cover **3 of 63** capabilities. The default kind (`wasm`) is used by **1 of 38** first-party plugins; `hybrid` and `vscode-extension` templates model shapes used by **zero**. 35 capabilities have no example anywhere in the repo.               | An author's realistic starting point is "read the source of 38 hand-written plugins".          |

**Sequencing follows from this.** Wave 0 exists because there is **no feedback loop**: the CLI's
tests are green but unguarded, and the one test that guarded host↔CLI drift is dead. Fix the loop
before fixing behaviour, or you cannot know whether a fix held.

**This is a small-diff epic.** Waves 0–2 are mostly one-line repoints, a missing `.gitignore`
entry, one genuinely substantive Rust function (`forward_payload`), and a handful of new tests.
The leverage is disproportionate to the diff size. Wave 3+ is where real design work starts.

### 0.3 Repo gates that apply to every item

From `CLAUDE.md` — hard rules:

- **Co-located tests.** New/changed `src-tauri/src/**` and `crates/**` need in-file
  `#[cfg(test)]`. Every Rust item below says which test to add. Non-negotiable.
- **No simplifications.** Do not stub or `// TODO later` a production path. W1.3 in particular
  must handle the full section graph — a partial fix that passes the new fixture but still
  `Err`s on some section kinds is the _same bug_, re-armed.
- **i18n.** N/A for the CLI (it has no i18n layer and no user-facing `.tsx`). Relevant only if
  W3.x adds manifest-i18n lint rules.
- **Changeset.** Marked per item. The CLI is not user-facing product surface, but W1.1 (key leak)
  and W1.3 (build works at all) change behaviour an author would notice — mark those `patch`.
- **Never `--no-verify`.** Hook fails → fix the cause, re-stage, new commit.

### 0.4 Tooling traps specific to this work

- **`rtk` masks cargo exit codes.** For any gate, read the summary line yourself or use
  `rtk proxy cargo ...`. [CONFIRMED — `rtk cargo test` printed one `test result: ok` line and hid
  the second test binary entirely; only `rtk proxy` revealed 240 + 102.]
- **Counting lint codes with grep will lie to you.** Rule codes contain uppercase
  (`cliTools`, `activateOnStartup`, `wasmMain`). `grep -oE 'code: *"[a-z0-9_.]+"'` silently
  returns **25**; the truth is **60**. Two independent subagents and the plan author all hit this.
  Use `[A-Za-z0-9_.]+`. [CONFIRMED]
- **`cargo test -p cognia-cli` builds two test binaries** — `unittests src/main.rs` (240) and
  `tests/integration.rs` (102). A single `test result` line means you are reading a filtered
  stream. [CONFIRMED]
- **The CLI binary for manual probing** is `target/debug/cognia` (workspace target is at the repo
  **root**, not `crates/cognia-cli/target/`). `pnpm dev` under Tauri auto-builds it via
  `scripts/dev/ensure-cognia-cli.mjs`; otherwise `cargo build -p cognia-cli`. [CONFIRMED]
- **Shared working tree.** Other sessions edit this checkout concurrently (130 files were already
  modified at audit time, including `crates/cognia-cli/src/cmd_build.rs`). Never bare-stash; don't
  trust `git status` you didn't just produce.
- **Probe in a temp dir, not the repo.** `plugin new` refuses a non-empty target, and a stray
  scaffold under `plugins/` will trip `first-party-manifests.test.ts`.

### 0.5 [RETRACTED] — fabricated research, quarantined

One subagent produced an industry-benchmark report, then **re-ran and retracted it as
fabricated**. Part of it had already been relayed. The failure mode is instructive: the invented
claims were _mixed_ — some accidentally correct (Zed's `zed:api-version`), some flatly wrong
(a `vsce` constant `FILE_SIZE_WARNING_THRESHOLD = 0.85` that **does not exist**). You cannot tell
which half you hold without redoing the work.

**Do not cite, and do not re-derive from the session log:**

- `cargo-generate`'s `--force` semantics — **scaffolders were never researched** (cargo-generate,
  degit, create-tauri-app, shadcn `add`, Yeoman).
- "warg is dead → OCI + cosign" — **the entire signing/supply-chain axis was never researched**
  (CRX3, AMO, cosign/sigstore, SLSA).
- VS Code's odd/even pre-release version convention.
- Figma's `reasoning` being "published on the Community page".
- Obsidian's submission bot having been "replaced on 2026-05-12 by per-release scanning".

**Open, genuinely un-researched** (see §5, [OPEN-4]): the whole signing/supply-chain axis, plugin
test harnesses, `@vscode/test-cli`, `create-figma-plugin`'s build CLI, Claude Code's plugin
validator.

---

## 1. STATUS — what is already good (do NOT redo)

Re-implementing any of this is a regression. The CLI is _well built_; it is _unguarded_.

- **`cognia:api-version` in a wasm custom section** (`packaging.rs:24`) is the single best design
  decision in the codebase. Zed independently converged on the identical mechanic
  (`zed:api-version`, parsed at `extension.rs:188-208` / `wasm_host.rs:811-834`) [AGENT], and Zed
  uses the **same target triple** (`RUST_TARGET = "wasm32-wasip2"`) [CONFIRMED — fetched verbatim].
  Version travels inside the artifact where it cannot drift from the code. **Keep it.**
- **Stable, dotted, machine-readable rule IDs** (`manifest.capabilities.invalid_item`). Better
  than addons-linter's flat 25-char-truncated `SCREAMING_SNAKE`, and vastly better than `vsce`,
  which has **no rule IDs at all** [AGENT]. Prefix-greppable and namespaceable. **Do not
  "upgrade" this.**
- **`--json` on every command, schema-versioned**, with stage-tagged failure payloads and a
  `JsonFailureExit` path. Ahead of vsce (JSON on `show`/`search` only), Raycast, and Obsidian
  [AGENT].
- **Detached `<bundle>.sig`** matches VS Code's better design — signatures as siblings, never
  embedded [AGENT].
- **342 tests, all green, zero warnings** (240 unit + 102 integration, 2.4 s). [CONFIRMED]
- **`preflight_wasm_toolchain`** (`cmd_build.rs:701-753` [AGENT]) probes `cargo component` and the
  `wasm32-wasip2` target and bails with install instructions. Good — just buried inside `build`
  (see W3.1).
- **`cliTools` validation is genuinely deep** — 24 rules including binary path-traversal
  (`cli_has_path_traversal`, `cmd_lint.rs:1426` [AGENT]). The helper you need for W2.3 already
  exists here.
- **Docs are unusually thorough** — 11 pages under `docs/content/docs/en/subsystems/cognia-cli/`
  plus 12 under `docs/content/docs/plugin-dev/`. Read `scaffolding.mdx` and `lint.mdx` before
  touching either area. **But every quantitative claim in `lint.mdx` is stale** — see W2.6.

---

## 2. Work items

### WAVE 0 — Restore the feedback loop

> Nothing in Waves 1–3 is safe until a regression can fail a build. Today none can.

#### W0.1 — Run the CLI's test suite in CI [CONFIRMED]

**Problem.** The CLI's 342 tests have **never run in CI**.

**Evidence.** `.github/workflows/test.yml:597`:

```yaml
- name: Run Rust tests
  working-directory: src-tauri
  run: cargo test --locked
```

`src-tauri` and `crates/cognia-cli` are both members of the **root** workspace
(`Cargo.toml:24-26`). Running `cargo test` from a member directory tests **only that member**.
And `grep -rln "cognia-cli" .github/` returns **zero files**.

**Fix.** Add the CLI to the Rust test job. Prefer a second step over `--workspace` — the workspace
is 20+ crates and `cognia-next` already dominates that job's wall clock:

```yaml
- name: Run Rust tests (cognia-cli)
  run: cargo test --locked -p cognia-cli
```

Note this step needs **no** `working-directory` and — unlike the `cognia-next` step — no
`pnpm build` prerequisite (the CLI has no `tauri::generate_context!`). If job time is a concern,
it can be a separate job with no Node setup at all.

**Verify.**

```bash
cargo test --locked -p cognia-cli 2>&1 | grep -E "^test result"
# MUST show two lines: 240 passed (unittests src/main.rs), 102 passed (tests/integration.rs)
```

Then confirm CI actually gates: land W1.3's fixture test first, revert the `forward_payload` fix
locally, and confirm the job goes red.

**Changeset:** no (CI only).

---

#### W0.2 — Repoint the dead Rust↔TS parity guard [CONFIRMED]

**Problem.** `lib/plugin/contracts/rust-capability-parity.test.ts` — the **only** enforcement of
Rust↔TS lockstep, which `lint.mdx:137-140` calls _"the only thing keeping a plain string list in a
separate crate honest"_ — **fails to load**. It has been dead since **2026-07-13**, commit
`531a00a8d` ("refactor(tauri): extract cognia-plugin-runtime crate", ADR-0067), which moved the
file it reads and never updated the path.

**Evidence.**

```
$ grep -n api_bridge lib/plugin/contracts/rust-capability-parity.test.ts
25:  join(REPO_ROOT, "src-tauri", "src", "plugin_api", "api_bridge.rs"),

$ ls src-tauri/src/plugin_api/api_bridge.rs
"src-tauri/src/plugin_api/api_bridge.rs": No such file or directory (os error 2)
$ ls crates/cognia-plugin-runtime/src/api_bridge.rs
.rw-r--r--@ 77k bytedance 13 Jul 11:55 crates/cognia-plugin-runtime/src/api_bridge.rs

$ npx jest lib/plugin/contracts/rust-capability-parity.test.ts
Test Suites: 1 failed, 1 total
Tests:       0 total          ← ENOENT at module load; no assertion ever executes
```

**This is worse than a missing test.** It fails _identically_ whether drift exists or not, so its
red state carries zero signal and reads as just another entry in this repo's known-broken-baseline
cluster.

**Fix.** Two parts — the repoint alone re-arms the same trap:

1. Repoint to `crates/cognia-plugin-runtime/src/api_bridge.rs`.
2. **Assert the path exists before reading**, so a future move fails _loudly_:

```ts
const API_BRIDGE_PATH = join(REPO_ROOT, "crates", "cognia-plugin-runtime", "src", "api_bridge.rs")
if (!existsSync(API_BRIDGE_PATH)) {
  throw new Error(
    `api_bridge.rs not found at ${API_BRIDGE_PATH}. It moved — repoint this guard. ` +
      `A silent ENOENT here disables Rust↔TS capability parity checking entirely.`
  )
}
```

Do the same for the other two `readFileSync` calls (`RUST_LINT` at :16, `TS_VALIDATION` at :20).

**Verify.**

```bash
npx jest lib/plugin/contracts/rust-capability-parity.test.ts
# MUST show 4 passing tests — NOT "Tests: 0 total"
```

Mutation check: point the path at a nonexistent file → must throw the explicit error, not ENOENT.

**Changeset:** no (test only).

---

#### W0.3 — Add a real-wasm fixture [CONFIRMED]

**Problem.** The wasm packaging path is tested **only** against an 8-byte degenerate module — the
one shape that happens to survive the bug in W1.3.

**Evidence.** `packaging.rs:421-424` [AGENT] defines `min_wasm()` as magic + version only
(`00 61 73 6d 01 00 00 00`). No test constructs a module with any real section. Confirmed
empirically:

```bash
$ printf '\x00\x61\x73\x6d\x01\x00\x00\x00' > degenerate.wasm
$ cognia plugin embed-version degenerate.wasm 0.1.0
embedded cognia:api-version = 0.1.0 into degenerate.wasm      # exit 0

$ printf '\x00\x61\x73\x6d\x01\x00\x00\x00\x01\x04\x01\x60\x00\x00' > realistic.wasm
$ cognia plugin embed-version realistic.wasm 0.1.0
Error: section forwarding for TypeSection("...") is not implemented   # exit 1
```

**Fix.** Add a fixture with a non-custom section. The minimum that reproduces is 14 bytes —
magic + version + one type section (`01 04 01 60 00 00` = section id 1, len 4, one entry, `0x60`
functype, 0 params, 0 results):

```rust
/// A module with a *real* section graph. `min_wasm()` (magic+version only) is a
/// degenerate shape that survives section handling no matter how broken it is —
/// it is not a regression test. Every real module has at least a type section.
fn wasm_with_type_section() -> Vec<u8> {
    let mut v = min_wasm();
    v.extend_from_slice(&[0x01, 0x04, 0x01, 0x60, 0x00, 0x00]);
    v
}
```

Assert `embed_api_version` **succeeds** on it, and that a `wasmparser` re-parse of the output
still finds both the type section and the `cognia:api-version` custom section.

Prefer also asserting against a genuinely compiled artifact if one is cheap to produce — but do
**not** make the unit test depend on `cargo component` being installed. Keep the byte fixture as
the always-on gate.

**Depends on:** nothing. **Land this before W1.3** — it is W1.3's failing test.

**Verify.** Test must be **red** before W1.3 and green after.

**Changeset:** no (test only).

---

### WAVE 1 — Fix the broken default path

#### W1.1 — Stop the default scaffold from committing the private signing key [CONFIRMED] 🔴

**Problem.** `cognia plugin new` with default options stages the author's **Ed25519 private
signing key** into git on their first `git add -A`.

**Evidence.** The wasm template's `.gitignore` omits `.cognia/`; the other four templates include
it:

```
$ cat crates/cognia-plugin-template/.gitignore
target/
Cargo.lock
*.wasm
*.sig
*.zip

$ cat crates/cognia-plugin-template-ts/.gitignore
node_modules/
dist/
coverage/
.cognia/          ← present here, absent above
*.log
```

Default kind is `wasm` (`cmd_new.rs:214` [AGENT]) and the TTY wizard defaults `--with-keygen` to
**true** (`cmd_new.rs:286-292` [AGENT]). Reproduced end-to-end:

```bash
$ cognia plugin new hello-wasm --kind wasm --with-keygen true --author T
$ cd hello-wasm && git init -q . && git add -A && git status --porcelain | grep cognia
A  .cognia/plugin.private.b64      ← the private key, staged
A  .cognia/plugin.public.b64
```

**Fix.** Add `.cognia/` to `crates/cognia-plugin-template/.gitignore`.

That is the one-line fix, but it is not the whole fix — **the template `.gitignore`s are five
independent copies with no shared floor.** Add a test that pins the invariant across all five:

```rust
#[test]
fn every_template_gitignores_the_private_key_directory() {
    for kind in TemplateKind::ALL {
        let files = files_for(kind, "probe");
        let gi = files.iter().find(|(p, _)| *p == ".gitignore")
            .expect("every template must ship a .gitignore");
        assert!(gi.1.lines().any(|l| l.trim() == ".cognia/"),
            "{kind:?} template's .gitignore must ignore .cognia/ — \
             `plugin new --with-keygen` writes the Ed25519 private key there");
    }
}
```

(`TemplateKind::ALL` may need adding — it is also what W1.4 and W3.2 want.)

**Consider also:** `keygen` writing a `.gitignore` containing `*` into `.cognia/` at creation time,
so the key is protected regardless of which template — or which _user-authored_ project — it lands
in. Defence in depth; the template fix is still required. [OPEN-1]

**Verify.**

```bash
cognia plugin new probe-wasm --kind wasm --with-keygen true --author T < /dev/null
cd probe-wasm && git init -q . && git add -A
git status --porcelain | grep -c "\.cognia/plugin\.private"   # MUST be 0
```

**Changeset:** `patch` — an author-visible security fix.

---

#### W1.2 — Substitute `wasmMain` [CONFIRMED]

**Problem.** Every wasm scaffold ships the _template's_ wasm filename, regardless of the plugin's
name.

**Evidence.** The manifest declares an **underscored** filename; substitution only replaces the
**hyphenated** package name:

```
$ grep -n wasmMain crates/cognia-plugin-template/plugin.json
8:  "wasmMain": "cognia_plugin_template.wasm"

$ grep -n 'replace("cognia' crates/cognia-cli/src/template.rs
312:        .replace("cognia-plugin-template", target_name)
313:        .replace("Cognia Plugin Template", &humanize(target_name))
```

`cognia_plugin_template` (underscores) never matches `cognia-plugin-template` (hyphens).
Reproduced — a scaffold named `hello-wasm`:

```
$ grep '"wasmMain"\|"id"' hello-wasm/plugin.json
  "id": "hello-wasm",
  "wasmMain": "cognia_plugin_template.wasm"      ← wrong; cargo-component emits hello_wasm.wasm
```

**Why it hides.** `packaging.rs:178-202` [AGENT] falls back to "first `*.wasm` in the target dir"
when the declared name misses, and `write_bundle` renames the zip entry to whatever `wasmMain`
says — so `plugin build` papers over it. The documented alternative in the template README
("install the raw `.wasm`") hands the host a file whose name contradicts its manifest.

**Fix.** Add the underscored form to `substitute_wasm_name`:

```rust
fn substitute_wasm_name(content: &str, target_name: &str) -> String {
    content
        .replace("cognia-plugin-template", target_name)
        // cargo-component normalizes `-` → `_` in the emitted artifact name, and
        // wasmMain must match that, not the package name. wasm32-wasip2 does the
        // same normalization inside the component itself.
        .replace("cognia_plugin_template", &target_name.replace('-', "_"))
        .replace("Cognia Plugin Template", &humanize(target_name))
}
```

Order matters — the hyphenated replace must run first, or `target_name` containing a `_` could be
re-substituted. Add a test asserting `wasmMain == "hello_wasm.wasm"` for a scaffold named
`hello-wasm`; the existing test (`cmd_new.rs:610-613` [AGENT]) checks only `Cargo.toml` name and
`plugin.json` id.

**Note.** Zed hit the identical `-`→`_` normalization trap in wasip2
(`extension_builder.rs:261` [AGENT]). This is inherent to the target, not a cognia quirk.

**Verify.**

```bash
cognia plugin new hello-wasm --kind wasm --author T < /dev/null
grep wasmMain hello-wasm/plugin.json   # MUST be "hello_wasm.wasm"
```

**Changeset:** `patch`.

---

#### W1.3 — Make `plugin build` work on real wasm modules [CONFIRMED] 🔴

**Problem.** `cognia plugin build` fails on **every real wasm plugin** — the default scaffold kind.

**Evidence.** `packaging::embed_api_version` (`packaging.rs:31`) unconditionally calls
`strip_section` (`:37`), which routes non-custom sections to `forward_payload` (`:110`). That
function handles only `CustomSection` (`:117`) and `Version` (`:128`); everything else hits `_ =>`
and returns `Err` (`:131-141`). [AGENT for line numbers; behaviour CONFIRMED:]

```bash
$ cognia plugin embed-version realistic.wasm 0.1.0    # magic+version+type section, 14 bytes
Error: section forwarding for TypeSection("...") is not implemented (this is a v0.1
limitation; re-embedding api-version on a wasm that wasn't previously embedded is fine,
but re-embedding twice on a complex section graph is not)                        # exit 1

$ cognia plugin embed-version tree-sitter.wasm 0.1.0  # a genuine 205 KB compiled module
Error: section forwarding for TypeSection("...") is not implemented               # exit 1
```

**Every real module has a type section.** `--skip-build` does not dodge it — the pack closure
always embeds (`cmd_build.rs:632-660` [AGENT]) — and `plugin dev` re-hits it every cycle
(`cmd_dev.rs:363` [AGENT]).

**The error message is inverted from reality.** It claims re-embedding on a fresh wasm "is fine"
(that is the _failing_ case) and that re-embedding twice is the problem (that case _passes_ on the
degenerate fixture). The real predicate is **"contains any non-custom section"**. Anyone
debugging from this message is sent the wrong way. Fix the text even if you fix the logic.

**Fix.** Handle the full section graph. **Do not special-case type/function sections** — that is
the same bug with a longer whitelist. `wasmparser` is already a dependency; `wasm_encoder` is the
natural counterpart for rebuild.

**Zed's `extension_builder.rs` is a working reference implementation for exactly this**, on the
**same target triple** [CONFIRMED — fetched verbatim]:

```
const RUST_TARGET: &str = "wasm32-wasip2";

// Default strip everything but:
// * the `name` section
// * any `component-type` sections
// * the `dylink.0` section
// * our custom version section
name != "name" && !name.starts_with("component-type:")
  && name != "dylink.0" && name != "zed:api-version"
```

Two lessons transfer directly:

1. **Forward every section kind**, not an enumerated subset. Unknown kinds must round-trip, not
   `Err`.
2. **Explicitly protect `cognia:api-version` from being stripped.** Zed wrote that condition
   deliberately, which means they shipped the bug first. Confirm cognia's build path cannot strip
   its own version section — and pin it with a test.

**Also confirm** the component-model case: cognia targets wasip2 and `cargo component` emits a
**component**, not a core module. Verify the fix handles component sections
(`ComponentTypeSection`, `ComponentImportSection`, …), not just core-module ones. The W0.3 byte
fixture is a core module and will **not** cover this — add a component-shaped fixture or the fix
will pass tests and still fail on real output. **This is the item most likely to be under-done.**

**Depends on:** W0.3 (its failing test).

**Verify.**

```bash
# 1. The unit fixture
cargo test -p cognia-cli packaging   # W0.3's test green

# 2. The real thing, end to end — the actual acceptance gate
rustup target add wasm32-wasip2 && cargo install --locked cargo-component
cognia plugin new e2e-wasm --kind wasm --author T < /dev/null
cd e2e-wasm && cognia plugin build          # MUST exit 0 and emit a .zip
cognia plugin info e2e-wasm-0.1.0.zip       # MUST show cognia:api-version

# 3. Idempotence — embedding twice must not corrupt
cognia plugin embed-version target/.../e2e_wasm.wasm 0.1.0
cognia plugin embed-version target/.../e2e_wasm.wasm 0.1.0   # MUST still exit 0
```

Step 2 has, as far as this audit can tell, **never been run**. Expect surprises past the first
error.

**Changeset:** `patch`.

---

#### W1.4 — Honour `--yes` in `plugin new` [CONFIRMED]

**Problem.** `--yes` is documented as _"Pre-confirm every interactive prompt … **Required for
CI**"_ (`main.rs:139-142` [AGENT]) but `cmd_new` never reads it. On a TTY,
`cognia plugin new foo --yes` still asks all six questions.

**Evidence.**

```
$ grep -c "flags.yes\|\.yes" crates/cognia-cli/src/cmd_new.rs
0
```

`collect_answers` branches only on `is_tty` [AGENT]. The `--yes` short-circuit exists only in
`RuntimeUi::confirm_overwrite` (`ui/runtime.rs:168-181` [AGENT]), which `cmd_new` never calls. The
only way to get a non-interactive scaffold today is to not be a terminal
(`cognia plugin new foo < /dev/null`) — which is how every probe in this plan is written.

**Fix.** In `collect_answers`, treat `flags.yes` as "take the default without prompting", i.e.
resolve each field as: explicit flag → else if `is_tty && !flags.yes` → prompt → else default.

**Watch the interaction with W1.1.** The wizard's `with_keygen` default is `true` while the
non-TTY default is `false`. `--yes` must pick one, and the two currently disagree. Recommend
`--yes` follows the **non-TTY** defaults (`false`) — "yes to prompts" should not mean "generate a
signing key I didn't ask for". Flag if you disagree; this is a real choice.

**Fix also:** `Prompter::multi_select` is implemented across all three prompters and marked
`#[allow(dead_code)]` with a comment reserving it for _"a future 'select capabilities' prompt"_
(`ui/prompter.rs:139-149` [AGENT]) — i.e. the capability picker was designed and never built.
Either wire it (W3.2) or delete it. Per `CLAUDE.md` Working Rule 7, intentional dormancy must be
documented at the type **and** labelled inert in the UI **and** pinned by a test; this is
currently one of three.

**Verify.** Requires a TTY, so it cannot be asserted from a normal test run. Add a unit test
driving `collect_answers` with a mock prompter (the pattern exists —
`wizard_collects_all_fields_via_mock_prompter`, `cmd_new.rs:285` [AGENT]) asserting **zero**
prompter calls when `flags.yes` is set. Manually confirm once in a real terminal.

**Changeset:** `patch`.

---

### WAVE 2 — Make `lint` an actual gate

#### W2.1 — Guard `CAPABILITY_FIELDS`, then fix its 7 divergences [CONFIRMED]

**Problem.** There are **four** hand-copied parity lists in `cmd_lint.rs`, not two (the team memory
records two). The fourth, `CAPABILITY_FIELDS` (44 rows), is guarded by **nothing** — and has
drifted in both directions.

**Evidence.** [list contents and line numbers AGENT; drift CONFIRMED by probe]

| #   | List                                       | Entries | Guarded?    | In sync?             |
| --- | ------------------------------------------ | ------- | ----------- | -------------------- |
| 1   | `VALID_PERMISSIONS` (`cmd_lint.rs:29-100`) | 70      | W0.2's test | ✅                   |
| 2   | `VALID_CAPABILITIES` (`:108-184`)          | 63      | W0.2's test | ✅                   |
| 3   | `VALID_PLUGIN_TYPES` (`:186`)              | 5       | W0.2's test | ✅                   |
| 4   | **`CAPABILITY_FIELDS` (`:193-238`)**       | 44      | **none**    | **❌ 7 divergences** |

(Lists 1–3 being "in sync" is author discipline, not enforcement — their guard has not run since
2026-07-13. See W0.2.)

Probed with a manifest declaring `themes` + the four subscription capabilities, all with **empty**
contribution arrays:

```
$ cognia plugin lint --json
valid= True  diagnostics= 1
   warning manifest.capability.field_missing | Capability "themes" is declared but its
                                               contribution field(s) "themes" are empty.
```

Two failures in one probe:

- **False positive:** Rust has `("themes", &["themes"])`; TS deliberately sets
  `manifestFields: []` (`plugin-capabilities.ts:196` [AGENT]) with an explicit comment that this
  exists _"so the validator's field cross-check doesn't flag module-manifest-authored themes as
  field_missing"_. The CLI emits precisely the warning the app suppresses.
- **False negatives:** `balance-adapter`, `limits-source`, `im-rate-source`,
  `compaction-strategy` → **zero diagnostics**. TS emits four `field_missing`. The comment at
  `cmd_lint.rs:158-165` [AGENT] records the author adding `balance-adapter` and
  `compaction-strategy` to `VALID_CAPABILITIES` — and never touching `CAPABILITY_FIELDS`.

**Root cause is structural.** TS iterates `PLUGIN_CAPABILITY_CONTRACTS` **directly**
(`validation.ts:452` [AGENT]) and auto-syncs. Rust hand-copies a 44-row table. **It will drift
again.**

**Fix — in this order:**

1. Extend W0.2's parity test to cover `CAPABILITY_FIELDS` against
   `PLUGIN_CAPABILITY_CONTRACTS[].manifestFields`. **Land the guard first** so the reconciliation
   is test-driven and the drift can't silently return.
2. Reconcile: add the 4 missing capabilities; drop `themes`; keep the `python` exemption
   (documented at `cmd_lint.rs:190-192` ≙ `validation.ts:454-457` [AGENT]) and **mirror the TS
   comment into the Rust source** so the next reader knows it is deliberate.

**Strongly consider [OPEN-2]:** codegen `VALID_*` + `CAPABILITY_FIELDS` from
`PLUGIN_CAPABILITY_CONTRACTS` (build script, or a committed JSON artifact both sides read). The
parity test only ever proved the copy was correct — and it stopped proving even that. Codegen
deletes this entire failure class. Note the cost: it puts a Node/TS step in the Rust build, which
the crate currently avoids entirely.

**Verify.** Re-run the drift probe above → **zero** diagnostics. Mutation: delete one row from
`CAPABILITY_FIELDS` → parity test must go red.

**Depends on:** W0.2.
**Changeset:** `patch` (changes lint verdicts).

---

#### W2.2 — Reject `entry` path traversal [CONFIRMED] 🔴

**Problem.** `plugin lint` accepts manifests the app's own validator rejects — including path
traversal and absolute paths.

**Evidence.** This manifest lints `valid: true`, **exit 0**, with one unrelated warning:

```json
{
  "id": "traversal-probe",
  "name": "Traversal Probe",
  "version": "0.1.0",
  "description": "probe",
  "type": "frontend",
  "main": "dist/DOES_NOT_EXIST.js",
  "minAppVersion": "999.0.0",
  "capabilities": ["message-renderer", "workspace-backend"],
  "messageRenderers": [
    { "id": "evil", "partType": "x", "entry": "../../../../etc/passwd", "export": "default" }
  ],
  "workspaceBackends": [
    { "id": "evil2", "label": "L", "entry": "/etc/shadow", "export": "default" }
  ],
  "activationEvents": ["onTotallyMadeUpEvent:xyz"],
  "author": { "publicKey": "NOT-VALID-BASE64!!!" },
  "capabilties": ["typo-key-ignored"],
  "tools": [
    { "name": "dup", "description": "a" },
    { "name": "dup", "description": "b" }
  ]
}
```

```
valid = True | errors = 0 | diagnostics: ['manifest.capability.field_undeclared']
exit=0
```

TS's `validateLazyFactoryArray` (`validation.ts:199-308` [AGENT]) guards `entry.traversal` (`..`),
`entry.absolute` (`/`, `C:\`), and `entry.invalid_chars` (NUL) across **seven** lazy-factory
fields: `ocrProviders`, `workspaceBackends`, `messageRenderers`, `aiProviders`, `modalMounts`,
`routingStrategies`, `chatMiddlewares`. **Rust implements none of them.**

**Fix.** Apply the existing `cli_has_path_traversal` helper (`cmd_lint.rs:1426` [AGENT] — already
used for `cliTools.binary.relPath`) to `entry` across all seven fields. Emit the TS code names
(`manifest.<field>.entry.traversal` etc.) so both validators speak one vocabulary.

**Scope note.** This is a **lint** gate, not a runtime sandbox. It stops honest mistakes and makes
CI meaningful; it is not a security boundary against a hostile manifest, because lint is
author-side and skippable. Do not let this item become an argument for skipping runtime
enforcement. **Confirm separately whether the loader enforces this at install** — if it does, this
is a UX fix; if it does not, that is a **separate and more serious finding** than anything in this
plan. [OPEN-3]

**Verify.** Re-run the probe → both `entry` values must produce errors and exit 1.

**Changeset:** `patch`.

---

#### W2.3 — Add a `Notice` severity and `--warnings-as-errors` [CONFIRMED]

**Problem.** `Severity` is two-tier (`Error | Warning`, `cmd_lint.rs:246-249`) and there is **no
`-W/--warnings-as-errors`** (`grep -rilE "warnings.as.errors|sarif"` → no hits). Errors exit 1,
warnings exit 0. **Every warning-severity rule is therefore decorative** — nothing can gate on
one. That includes the `field_missing` rules W2.1 just fixed.

**Fix.** Add `Notice` (never gates; the "audited, informational" tier) and `-W`. Copy
addons-linter's exit logic — it is the ecosystem's reference and maps 1:1 onto SARIF
`error`/`warning`/`note` [AGENT]:

```javascript
let exitCode = this.output.errors.length > 0 ? 1 : 0
if (exitCode === 0 && this.config.warningsAsErrors === true) {
  exitCode = this.output.warnings.length > 0 ? 1 : 0
}
```

Bump the `--json` `schemaVersion` — adding a third severity changes the payload's meaning for any
consumer bucketing on it.

**Verify.** A manifest with exactly one warning: `lint` → exit 0; `lint -W` → exit 1. Pin both in
`tests/integration.rs` alongside the existing exit-code tests (`:677-746` [AGENT]).

**Changeset:** `patch`.

---

#### W2.4 — Add `file`/`line`/`column` to `Diagnostic` [AGENT]

**Problem.** `Diagnostic { severity, field, code, message, hint }` (`cmd_lint.rs:252`) carries no
source position. This blocks SARIF, blocks editor integration, and makes a 60-rule linter's output
harder to act on than it should be.

**Fix.** Add optional `file`/`line`/`column`. `serde_json` does not preserve positions, so this
needs a position-aware parse of `plugin.json` (e.g. `serde_json`'s raw value spans, or a
JSON-with-positions crate). **Non-trivial — do not bundle it with W2.3.** Bump `schemaVersion`.

Once landed, SARIF output (`code` → `ruleId`; `error`/`warning`/`note` maps free) is a small
follow-on and unlocks `gh code-scanning upload-sarif`.

**Depends on:** W2.3 (do the cheap severity work first; don't stack two schema bumps).
**Changeset:** `patch`.

---

#### W2.5 — Unify the two `--json` payload shapes [AGENT]

**Problem.** Both payloads claim `schemaVersion: 1` but have different key sets — success/
lint-error emits `manifest_path`; input-failure emits `path` + `stage`. A CI consumer reading
`.manifest_path` gets `undefined` on input failure. `manifest_path` is also snake_case while
`schemaVersion` is camelCase, **within one payload**.

**Fix.** One shape. Prefer camelCase throughout (`manifestPath`) and always emit `stage`. Bump
`schemaVersion` — this is a breaking wire change. Fold into W2.3's bump if they land together.

**Related, verify separately:** `cmd_info.rs:197` [AGENT] hardcodes `ok: true`, so
`cognia plugin info --json | jq -e .ok` **passes for a tampered bundle** whose nested payload says
`"status":"invalid"`. `cognia plugin verify` correctly exits 1. Either make `info`'s `ok` reflect
signature status or rename it `inspected` and document that `info` is not a gate. **Re-verify this
one before acting** — it is [AGENT] and it contradicts `verify`'s correct behaviour, which is odd
enough to warrant a second look.

**Changeset:** `patch`.

---

#### W2.6 — Correct `lint.mdx` [CONFIRMED]

**Problem.** Every quantitative claim in `docs/content/docs/en/subsystems/cognia-cli/lint.mdx` is
wrong, and its central claim is now false.

| Claim                                                                                                                                                         | Reality                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| "45 permissions"                                                                                                                                              | **70**                                                 |
| "45 capabilities"                                                                                                                                             | **63**                                                 |
| "1,926 lines"                                                                                                                                                 | **2,047**                                              |
| "**Three** whitelists"                                                                                                                                        | **Four** (`CAPABILITY_FIELDS` is unmentioned)          |
| "41 项 CAPABILITY_FIELDS" (zh)                                                                                                                                | **44**                                                 |
| "Add a permission on either side without the other and `pnpm test` fails — **this is the only thing** keeping a plain string list in a separate crate honest" | **False since 2026-07-13.** The suite ENOENTs at load. |

**Fix.** Correct the numbers; document the fourth list; rewrite the parity paragraph to describe
what W0.2/W2.1 actually deliver. Bilingual — `en` **and** `zh` (see `.claude/rules/docs.md`;
`pnpm docs:build` is the only check that catches MDX prerender errors).

**Consider:** generate the counts. Every number here is `len()` of a list in `cmd_lint.rs`; they
were correct once and rotted silently. A doc that restates a constant will drift from it.

**Depends on:** W0.2, W2.1 (document the end state, not an intermediate one).
**Changeset:** no (docs).

---

### WAVE 3 — Close the authoring gap

> Waves 0–2 are repairs with obvious right answers. Wave 3 is design work. Do not start it until
> the loop is closed and the default path works — otherwise you are building on the walls in §0.2.

#### W3.1 — `cognia plugin doctor` [AGENT + benchmark]

**Why this one first.** It is the cheapest differentiator on the board: **no plugin CLI in the
surveyed set has a doctor except Tauri** (`tauri info --interactive`, which diagnoses _and offers
to fix_) [AGENT]. And cognia's pieces already exist, just uncomposed:

- `preflight_wasm_toolchain` (`cmd_build.rs:701-753` [AGENT]) — `cargo component`, `wasm32-wasip2`
  target, with install instructions. Currently fires only inside `build`, only for wasm, only
  _after_ you've written code.
- `probe_bridge_status` (`cmd_status.rs:47` [AGENT]) — desktop bridge reachability.
- The wasm template README hand-maintains a troubleshooting table duplicating what
  `preflight_wasm_toolchain` already detects programmatically [AGENT].

**Fix.** `cognia plugin doctor [--fix] [--json]` checking: rustup + `wasm32-wasip2`,
`cargo-component`, esbuild/node, bridge reachable, keypair present **and gitignored** (W1.1's
invariant, checked in the author's real project), manifest lints clean. `--fix` offers the
actionable ones.

Then **point at it from `next_steps`** — currently no template mentions `doctor`, `install`, or
`dev` at all, and the wasm template is the only kind whose next-steps skip `lint` [AGENT].

**Changeset:** `minor` (new command).

---

#### W3.2 — Make the templates model the real world [CONFIRMED]

**Problem.** The templates model a distribution that does not exist.

**Evidence** (measured across all 38 first-party `plugin.json`):

|                    | Templates           | Reality     |
| ------------------ | ------------------- | ----------- |
| `frontend`         | 1 (`ts`)            | **36 / 38** |
| `python`           | 1                   | 1           |
| `wasm`             | 1 — **the default** | **1**       |
| `hybrid`           | 1                   | **0**       |
| `vscode-extension` | 1                   | **0**       |

**Two of five templates model shapes nobody uses, and the default kind is the rarest.** Capability
coverage is worse: templates scaffold **3 of 63** (`tools`, `commands`, `python`); first-party
plugins exercise **28 of 63**; **35 capabilities have no example anywhere**, including
`webview`, `tree-view`, `auth-provider`, `uri-handler`, `quick-action`, `configuration`, `tray`.
`lib/plugin/api/` has ~48 API modules [AGENT]; templates demonstrate `ctx.agent.registerTool` and
the slash-command registry, and nothing else.

Also: the wasm and vscode templates declare `"capabilities": []` while their code implements real
exports — **they ship dormant** [AGENT], violating Working Rule 7.

**This is [OPEN-5]** — the fix is a strategy choice, not a patch. Options, with the honest trade:

- **(a) Default to `ts`.** One-line, immediate, matches 36/38 of reality. Do this regardless of
  what else you pick.
- **(b) Fix the dormant templates' manifests** so a fresh scaffold's exports are live. Small,
  clearly right, unblocks nothing else.
- **(c) `cognia plugin add <capability>`** — the `nest generate` / `shadcn add` pattern. `new` is
  one-shot today; `multi_select` is already implemented and dead (W1.4) precisely for this.
  Scales to 63 capabilities in a way that 63 templates never will. Biggest design cost.
- **(d) Promote the two `*-example` plugins.** `external-agent-adapter-example` and
  `external-agent-preset-example` already exist in `plugins/` — the "template" role has **already
  leaked** out of the CLI, informally and undiscoverable. Either make examples first-class and
  discoverable (`cognia plugin new --from-example <id>`) or fold them in.
- **(e) Retire `hybrid`/`vscode-extension`.** Zero users. But retiring a template is a
  compatibility decision, not a cleanup.

Recommend **(a)+(b) now** (small, obviously right, no strategy commitment), then decide (c)/(d)
deliberately. Do **not** attempt 63 templates.

**Changeset:** `minor`.

---

#### W3.3 — A test story for plugin authors [AGENT]

**Problem.** There is no `cognia plugin test`. The `ts` template is the only kind that ships tests
at all — and it is genuinely good (jest + ts-jest, `src/__shims__/` mapping `@/*` locally, wired
into `next_steps`). **wasm/python/hybrid/vscode ship zero tests** [AGENT].
`createMockPluginContext` exists (`lib/plugin/devtools/dev-tools.ts:368` [AGENT]) but is
unreachable for out-of-repo authors and unused by first-party plugins, which hand-roll `makeCtx()`.

Note this collides with `CLAUDE.md` Working Rule 3 ("every component ships with a unit test") —
the CLI scaffolds four of five plugin kinds in violation of the repo's own rule.

**Fix.** Ship `createMockPluginContext` as part of the plugin SDK surface so an out-of-repo author
can import it; give every template a real test; add `cognia plugin test` that shells into the
kind's runner.

**Depends on:** W3.2 (don't write tests for templates you may retire).
**Changeset:** `minor`.

---

#### W3.4 — Version-gated capability schema [AGENT + benchmark]

**Problem.** `minAppVersion` is format-checked only (`cmd_lint.rs:843-861` [AGENT]).
`minAppVersion: "999.0.0"` **lints green** and then **blocks at install** via the `compat.*` family
(9 codes, `lib/plugin/core/compatibility.ts:119-254` [AGENT], live at load via
`manager.ts:997`). `engines` appears **zero times** in `cmd_lint.rs`.

**The mechanic to copy** [AGENT]: `web-ext` bundles a Firefox API schema **per release** and lints
API calls against the declared `strict_min_version`, powering `INCOMPATIBLE_API` and
`PERMISSION_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` (notice tier — which W2.3 is the prerequisite for).

You already have the artifact-side half (`cognia:api-version`). The missing half is a bundled
per-host-version capability table so lint can say _"you declare `memory` but `minAppVersion:
0.4.0` predates it."_

**Also consider** Zed's channel-gated ABI range [AGENT]: 10 WIT dirs `since_v0.0.1`…`since_v0.8.0`;
Dev/Nightly → `latest::MAX_VERSION`, Stable/Preview → `since_v0_6_0::MAX_VERSION`; floor stays at
`since_v0_0_1::MIN_VERSION`. **The ceiling moves, not the floor**; a new ABI graduates by moving
one match arm. Worth adopting _before_ you need a second ABI version, not after.

**Depends on:** W2.3 (notice tier), W2.1 (a trustworthy capability list).
**Changeset:** `minor`.

---

#### W3.5 — Suppressions, before the rule count grows [AGENT + benchmark]

**Problem.** 60 rules, **zero suppression** — no inline comment, no config file, no flag. This is
exactly addons-linter's trap: ~100 rule IDs and no way to suppress any; the request (#2941, 2019)
was **auto-closed by a stale bot** with users still asking in 2021 [AGENT]. **Rule IDs create an
obligation.**

**Fix — copy ESLint 9's bulk suppressions** [AGENT]:

```json
{ "src/file1.js": { "no-undef": { "count": 1 } } }
```

`--suppress-all` · `--suppress-rule <name>` · `--prune-suppressions` ·
`--pass-on-unpruned-suppressions`. **The anti-rot mechanic: unused suppressions exit non-zero**,
and counts are per-file+rule so an _increase_ still surfaces.

**Why this repo specifically.** The memory index carries a whole cluster of _"baseline broken"_
entries (typecheck, lint, i18n-sort, rust-toolchain, coverage:changed) — permanently-red gates
nobody can act on. A counted, self-pruning baseline is the general fix for that disease. Do not
grow a bypass flag per rule (`vsce`'s mistake: `--allow-star-activation`,
`--allow-missing-repository`, `--allow-package-all-secrets`, … [AGENT]). **One suppression
mechanism beats N flags.**

**Depends on:** W2.4 (suppressions key on file+rule; positions make them precise).
**Changeset:** `minor`.

---

#### W3.6 — Namespace beyond `manifest.*` [CONFIRMED]

**Problem.** The rule set is severely lopsided. Census of `cmd_lint.rs` (60 distinct literal codes

- 1 `format!` template, **all** prefixed `manifest.`):

| Count  | Group                     |
| ------ | ------------------------- |
| **24** | `manifest.cliTools.*`     |
| 8      | `manifest.dexie.*`        |
| 5      | `manifest.wasm.*`         |
| 4      | `manifest.capabilities.*` |
| 19     | everything else (≤2 each) |

**40% of the rule set covers `cliTools`** — a capability exactly **one** first-party plugin uses
(`ripgrep-tools`). The other 62 capabilities share ~23 mostly presence-only rules; the
capability↔field cross-check only asserts "array is non-empty", never inspects contents. ~40
contribution arrays are presence-only [AGENT].

**Fix.** Rules beyond the manifest: `wasm.*` (module shape — W1.3's territory), `bundle.*` (size,
layout, entry existence), `js.*`. **Obsidian's `eslint-plugin-obsidianmd` is the model** — 41
rules grouped `commands/*`, `settings-tab/*`, `ui/*`, `vault/*`, and notably **`validate-manifest`
is itself a lint rule**, not a separate pass [AGENT].

Cheap high-value additions [AGENT]:

- **File existence** — `main: "dist/DOES_NOT_EXIST.js"` currently passes. No manifest↔code drift
  check exists at all.
- **Unknown top-level keys** — `capabilties`/`tolls` typos are silently ignored. **No JSON Schema
  exists in-repo**, so both validators are hand-written and drift-prone _by construction_.
  Consider generating one from `PLUGIN_CAPABILITY_CONTRACTS` (ties to [OPEN-2]).
- **Levenshtein "did you mean"** on unknown keys — trivial, disproportionate UX return [AGENT].
- **Duplicate `tools[].name` / `commands[].id`** — unchecked, though `dexie.tables` _is_ deduped.
- **`author.publicKey` validity** — never validated, though `cmd_verify.rs:211` depends on it.
- **`hybrid` entry points** — checked by **neither** validator; Rust's `match plugin_type` has no
  `hybrid` arm, and TS's branches are dead. A `hybrid` with neither `main` nor `pythonMain` lints
  clean [AGENT].

**Not a gap — recorded so nobody chases it:** `pnpm audit:slots` is a red herring. Slots are
_host-side_ mount points; no `plugins/*/plugin.json` declares a `point`/`extensionPoint` key, so
there is no manifest-side slot rule for the CLI to be missing [AGENT].

**Depends on:** W2.3, W2.4.
**Changeset:** `minor`.

---

### WAVE 4 — Distribution

#### W4.1 — Decide what "ship a plugin" means [CONFIRMED + AGENT]

**Problem.** There is no path from "I built a plugin" to "a user installed it". `build`/`sign`/
`install` all target **your own** running desktop via the loopback bridge.

**Evidence.**

- No `publish` command [AGENT].
- The registry default is `https://plugins.cognia.app/api/v1`
  (`lib/plugin/package/marketplace.ts:190` [AGENT]) — **no corresponding service exists in-repo**
  (`services/` holds only `share-server` and `signaling-server`), and the client is read-only.
- `@cognia/*` is in the changesets `ignore` list, so the SDK is not on npm either.
- **The CLI itself is undistributed.** `cognia release-verify` + `cmd_release_key.rs` exist to
  verify _"downloaded cognia CLI release artifacts"_ against an embedded public key — but **no
  workflow produces such artifacts** (`grep -rln "cognia-cli" .github/` → zero) and the key is an
  all-zero sentinel, so `release-verify` reports `skipped-placeholder-key` [AGENT]. Dormant on all
  three axes.
- The only way an external author obtains the CLI is cloning the monorepo and running cargo.
  [CONFIRMED — `scripts/dev/ensure-cognia-cli.mjs` builds it into `target/debug/` for Tauri dev
  only, and is a deliberate no-op for web-only contributors.]

**This is [OPEN-6] and it is the largest open question in this document.** It is a product
decision, not an engineering task, and it is upstream of how much of Wave 3 is worth doing. Note
Zed is _shedding_ registries (deprecating `[context_servers]` → official MCP registry,
`[agent_servers]` → ACP Registry, keeping only languages/themes/debuggers/LLM-providers) [AGENT] —
running a registry is a long-term commitment, and one credible answer is "don't".

**Do not start W4 work before §5 [OPEN-6] is answered.**

---

## 3. Sequencing & dependencies

```
W0.1 (CI runs CLI tests) ─┐
W0.2 (repoint parity)  ───┼──> W2.1 (CAPABILITY_FIELDS guard + reconcile) ──> W2.6 (docs)
W0.3 (real-wasm fixture) ─┴──> W1.3 (forward_payload)  🔴

W1.1 (.gitignore key leak) 🔴   ── independent, land first, smallest diff
W1.2 (wasmMain)                 ── independent
W1.4 (--yes)                    ── interacts with W1.1's keygen default

W2.2 (entry traversal) 🔴       ── independent of W2.1
W2.3 (Notice + -W) ──> W2.4 (file/line/col) ──> W3.5 (suppressions)
                  └──> W3.4 (version-gated schema)  <── also needs W2.1
W2.5 (json shape)               ── fold into W2.3's schemaVersion bump

W3.1 (doctor)                   ── independent; cheapest differentiator
W3.2 (templates) ──> W3.3 (test story)
W3.6 (namespacing)              ── needs W2.3 + W2.4

W4.1 — BLOCKED on [OPEN-6]
```

**Suggested first commit:** W1.1. One line, closes a key leak, and its test forces
`TemplateKind::ALL` into existence — which W1.4 and W3.2 both want.

**Critical path to "the default path works":** W0.3 → W1.3, with W1.1 + W1.2 alongside. That is
the minimum that makes `cognia plugin new` → `cognia plugin build` succeed for a new author.

---

## 4. Whole-epic verification

The gate is **not** "342 tests still pass" — they passed throughout every defect in this document.

```bash
# 1. The suite runs, and CI runs it
cargo test --locked -p cognia-cli 2>&1 | grep -E "^test result"
#    MUST show 240+ and 102+ passing. Then confirm the CI job exists and gates.

# 2. The parity guard is alive
npx jest lib/plugin/contracts/rust-capability-parity.test.ts
#    MUST show 4 passing — NOT "Tests: 0 total"

# 3. The default path works end to end — the acceptance test
cd "$(mktemp -d)"
cognia plugin new demo --kind wasm --with-keygen true --author T < /dev/null
cd demo && git init -q . && git add -A
git status --porcelain | grep -c "\.cognia/plugin\.private"   # MUST be 0
grep wasmMain plugin.json                                     # MUST be "demo.wasm"
cognia plugin lint                                            # MUST exit 0
cognia plugin build                                           # MUST exit 0 + emit .zip

# 4. Lint is a gate — each MUST now exit non-zero:
#    - entry: "../../../../etc/passwd"                        → W2.2
#    - entry: "/etc/shadow"                                   → W2.2
#    - the 4 subscription caps with empty fields (with -W)    → W2.1
#    - `themes` with empty themes[]                           → W2.1 (must NOT warn)

# 5. Mutation spot-checks — the real gate. Each MUST go red:
#    - drop `.cognia/` from the wasm template .gitignore      → W1.1
#    - revert forward_payload's `_ =>` arm to Err(...)        → W1.3
#    - strip cognia:api-version in the build path             → W1.3
#    - delete one CAPABILITY_FIELDS row                       → W2.1
#    - point the parity test at a nonexistent path            → W0.2 (explicit error, not ENOENT)
#    - re-add `("themes", &["themes"])`                       → W2.1
```

**Check 5 is the point of this epic.** Every defect here survived a green suite because the tests
asserted the degenerate case. If a mutation does not go red, the corresponding fix is not done.

---

## 5. Open decisions — do not decide these silently

### [OPEN-1] Should `keygen` self-protect? (affects W1.1)

W1.1 fixes the template. But `keygen` can also run in a **user-authored** project with no cognia
template and no `.cognia/` ignore. Should `keygen` write `.cognia/.gitignore` containing `*` at
creation time? Pro: protects every path, including projects we don't control. Con: writing
gitignores into a user's tree is opinionated, and a `.gitignore` inside an ignored dir is a
slightly obscure idiom. **Recommend yes** — the blast radius of a leaked signing key is total, and
the fix is 3 lines. Not a substitute for W1.1.

### [OPEN-2] Codegen the parity lists, or keep hand-copying + a guard? (affects W2.1)

Codegen (build script or committed JSON both sides read) deletes the whole drift class — the
parity test only ever proved the copy was correct, and it stopped proving even that for three
days. **Cost:** puts a Node/TS step into a Rust crate build that currently has none, and
`cognia-cli` is deliberately dependency-light (`ureq` over `reqwest`, `tungstenite` over tokio, to
keep the binary lean). A committed JSON artifact + a test that it's fresh is the middle path.
**Needs a decision before W2.1's reconcile**, or you'll do the work twice.

### [OPEN-3] Does the loader enforce `entry` traversal at install? (blocks W2.2's framing)

W2.2 adds a **lint** rule, which is author-side and skippable. If the TS loader enforces
`validateLazyFactoryArray` at install for _all_ sources (including a hand-placed dev plugin), W2.2
is a UX fix. If it does **not**, there is a runtime path-traversal hole and that is a far more
serious finding than anything in this plan. **Verify before writing W2.2's commit message** —
`lib/plugin/core/manager.ts` + `loader.ts`, all install roots (`builtin`/`installed`/`dev`).

### [OPEN-4] Re-research the un-researched axes? (affects W4.x, W3.3)

§0.5 quarantines a fabricated report. Genuinely open, never researched: the whole
signing/supply-chain axis (CRX3, AMO, cosign/sigstore, SLSA provenance), plugin test harnesses,
`@vscode/test-cli`, `create-figma-plugin`'s build CLI, Claude Code's plugin validator, scaffolder
comparables. Worth a fresh pass **only if** [OPEN-6] says cognia distributes plugins to third
parties — otherwise the signing axis is moot and the money is in W3.1/W3.2.

### [OPEN-5] Template strategy (blocks W3.2's (c)/(d))

Default to `ts` and fix the dormant manifests now — those are unambiguous. But `add <capability>`
(c) vs first-class examples (d) vs retiring the dead kinds (e) is a product call about who the
plugin author _is_. 63 capabilities × 5 types cannot be covered by templates; something has to
give. **Recommend shipping (a)+(b), then deciding.**

### [OPEN-6] Is there a distribution story at all? (blocks all of W4)

`plugins.cognia.app` is referenced and does not exist. The CLI's own release-verification
machinery is built and unprovisioned. Three coherent answers:

1. **Build the registry** — biggest commitment; note Zed is actively shedding registries.
2. **Git/GitHub-sourced marketplaces** (`marketplace.json` in a repo, the Claude Code / Obsidian
   shape) — `PluginSource = "git"` already exists at `types/plugin/plugin.ts:213`, so the platform
   already models it and the CLI simply can't produce for it.
3. **First-party only, forever** — plugins ship in-tree; delete `release-verify`, the registry
   default, and most of W4. **Legitimate**, and it makes much of Wave 3 lower priority.

**Nothing in W4 should be built before this is answered.** It also changes W3's priority: if (3),
`doctor` and templates serve _internal_ authors, and the signing axis is dead weight.

---

## 6. Source evidence

Everything marked [CONFIRMED] was produced against the real built binary
(`target/debug/cognia`, built from `codex/otel-native-telemetry` @ `4afa2d8c7`) or by reading the
file. Commands are reproducible as written.

| Finding                                                             | How verified                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Private key staged by default scaffold                              | `plugin new hello-wasm --kind wasm --with-keygen true` → `git add -A` → `git status --porcelain` |
| `wasmMain` unsubstituted                                            | same scaffold → `grep wasmMain hello-wasm/plugin.json`                                           |
| `embed-version` fails on real wasm                                  | 8-byte vs 14-byte fixture; plus a genuine 205 KB `tree-sitter.wasm`                              |
| `--yes` dead in `cmd_new`                                           | `grep -c "flags.yes\|\.yes" cmd_new.rs` → 0                                                      |
| Parity test dead                                                    | `ls` both paths + `npx jest` → `Tests: 0 total`                                                  |
| `CAPABILITY_FIELDS` drift                                           | `plugin lint --json` on a 5-capability probe manifest                                            |
| Lint accepts traversal                                              | `plugin lint --json` on the §W2.2 probe → `valid: true`, exit 0                                  |
| 60 lint codes, 24 `cliTools`                                        | `re.findall(r'code:\s*"([A-Za-z0-9_.]+)"')` — **note the uppercase**                             |
| 342 tests pass                                                      | `rtk proxy cargo test -p cognia-cli --locked`                                                    |
| CI never runs the CLI                                               | `test.yml:597` `working-directory: src-tauri` + `grep -rln cognia-cli .github/` → 0              |
| 63 capabilities / 28 used / 35 unused                               | script over `types/plugin/plugin.ts` + all `plugins/*/plugin.json`                               |
| 38 manifests: 36 frontend / 1 python / 1 wasm / 0 hybrid / 0 vscode | same script                                                                                      |
| Zed strips sections, whitelists `zed:api-version`, targets wasip2   | WebFetch of `zed-industries/zed` `crates/extension/src/extension_builder.rs`, quoted verbatim    |

**Audit method.** Four parallel read-only subagents (scaffolding, lint, build/dev/sign, industry
benchmark) plus direct verification of every load-bearing claim. **The benchmark agent's first
report was fabricated and retracted** (§0.5) — which is why [AGENT] claims in this document carry
a re-verify instruction rather than being promoted to fact. Two of the four agents also
independently reported the lint rule count as 25; the correct answer is 60, and it was only
obtained by not trusting them.

**Nothing in the working tree was modified by this audit.** `crates/cognia-cli/src/cmd_build.rs`
was already dirty at audit start, along with 129 other files — this checkout is shared with other
sessions.
