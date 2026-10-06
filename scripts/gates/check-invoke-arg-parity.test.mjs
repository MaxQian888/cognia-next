import { test } from "node:test"
import assert from "node:assert/strict"

import {
  analyze,
  collectRepositoryFindings,
  collectRegisteredCommands,
  diffAgainstBaseline,
  readBaseline,
  selectRegisteredCommands,
  parseInvokeCommands,
  verifiedRegistrationOwners,
} from "./check-invoke-arg-parity.mjs"
import { findInvokeCallSites, objectLiteralKeys } from "./lib/invoke-call-sites.mjs"

const command = (name, params, channelParams = []) => ({
  name,
  file: `crates/x/src/${name}.rs`,
  line: 1,
  params,
  channelParams,
  returnType: "Result<()>",
})

const site = (source) => findInvokeCallSites(source, "lib/x.ts")

// ---------------------------------------------------------------------------
// Argument-object parsing
// ---------------------------------------------------------------------------

test("reads shorthand, explicit, and quoted top-level keys", () => {
  assert.deepEqual(objectLiteralKeys(`a, b: 1, "c-d": 2`).keys, ["a", "b", "c-d"])
})

test("ignores keys nested inside objects, arrays, and calls", () => {
  const { keys } = objectLiteralKeys(`
    outer: { inner: 1, deeper: { deepest: 2 } },
    list: [{ nested: 3 }],
    made: build({ hidden: 4 }),
    tail: 5
  `)
  assert.deepEqual(keys, ["outer", "list", "made", "tail"])
})

test("notes a spread rather than pretending the keys are complete", () => {
  const parsed = objectLiteralKeys(`a: 1, ...rest, b: 2`)
  assert.equal(parsed.hasSpread, true)
  assert.deepEqual(parsed.keys, ["a", "b"])
})

test("a brace or colon inside a string does not confuse the scan", () => {
  assert.deepEqual(objectLiteralKeys(`url: "https://x/{y}:z", after: 1`).keys, ["url", "after"])
})

test("classifies the second argument as object, opaque, or none", () => {
  assert.equal(site(`invoke("a", { x: 1 })`)[0].kind, "object")
  assert.equal(site(`invoke("a", args)`)[0].kind, "opaque")
  assert.equal(site(`invoke("a")`)[0].kind, "none")
  assert.equal(site(`invoke<Result>("a", { x: 1 })`)[0].kind, "object")
})

test("records the command name and line of each call site", () => {
  const found = site(`const x = 1\nawait invoke("plugin_load", { pluginId })`)
  assert.equal(found[0].command, "plugin_load")
  assert.equal(found[0].line, 2)
  assert.deepEqual(found[0].keys, ["pluginId"])
})

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

test("the plugin_install shape mismatch is exactly what this gate exists to catch", () => {
  // manager.ts sent { source, installType, pluginDir } against a signature of
  // (plugin_id, source, payload). Neither pluginId nor payload crossed the
  // wire, and every test covering the path mocked invoke().
  const findings = analyze(
    site(`invoke("plugin_install", { source, installType: type, pluginDir: dir })`),
    new Map([
      [
        "plugin_install",
        command("plugin_install", [
          { name: "plugin_id", type: "String" },
          { name: "source", type: "String" },
          { name: "payload", type: "InstallPayload" },
        ]),
      ],
    ])
  )
  const keys = findings.map((f) => f.key.split(":").slice(-2).join(":"))
  assert.deepEqual(keys.sort(), [
    "missing-argument:payload",
    "missing-argument:plugin_id",
    "unknown-argument:installType",
    "unknown-argument:pluginDir",
  ])
})

test("camelCase and snake_case are the same argument", () => {
  // Tauri deserializes `plugin_id` from the JS `pluginId`; that is not a defect.
  assert.deepEqual(
    analyze(
      site(`invoke("x", { pluginId: id })`),
      new Map([["x", command("x", [{ name: "plugin_id", type: "String" }])]])
    ),
    []
  )
})

test("an Option parameter may be omitted", () => {
  assert.deepEqual(
    analyze(
      site(`invoke("x", { a: 1 })`),
      new Map([
        [
          "x",
          command("x", [
            { name: "a", type: "String" },
            { name: "b", type: "Option<String>" },
          ]),
        ],
      ])
    ),
    []
  )
})

test("a Channel parameter is a legitimate required wire key", () => {
  // parseTauriCommands splits channels out of `params` because they are not
  // JSON payload, but the caller really does pass one.
  const missing = analyze(
    site(`invoke("x", { input })`),
    new Map([["x", command("x", [{ name: "input", type: "Input" }], ["on_event"])]])
  )
  assert.equal(missing.length, 1)
  assert.match(missing[0].key, /missing-argument:on_event$/)
  assert.deepEqual(
    analyze(
      site(`invoke("x", { input, onEvent })`),
      new Map([["x", command("x", [{ name: "input", type: "Input" }], ["on_event"])]])
    ),
    []
  )
})

test("a spread suppresses the missing-argument half but not the unknown half", () => {
  const commands = new Map([["x", command("x", [{ name: "a", type: "String" }])]])
  assert.deepEqual(analyze(site(`invoke("x", { ...rest })`), commands), [])

  const findings = analyze(site(`invoke("x", { ...rest, bogus: 1 })`), commands)
  assert.equal(findings.length, 1)
  assert.match(findings[0].key, /unknown-argument:bogus$/)
})

test("an opaque argument object is skipped rather than guessed at", () => {
  assert.deepEqual(
    analyze(
      site(`invoke("x", buildArgs())`),
      new Map([["x", command("x", [{ name: "a", type: "String" }])]])
    ),
    []
  )
})

test("an unregistered command is command-parity's finding, not ours", () => {
  assert.deepEqual(analyze(site(`invoke("nope", { a: 1 })`), new Map()), [])
})

// ---------------------------------------------------------------------------
// Ratchet
// ---------------------------------------------------------------------------

test("the ratchet reports new findings and celebrates fixed ones", () => {
  const findings = [{ key: "f/a.ts:cmd:unknown-argument:x", detail: "…" }]
  assert.deepEqual(diffAgainstBaseline(findings, []).added, findings)
  assert.deepEqual(diffAgainstBaseline(findings, [findings[0].key]).added, [])
  assert.deepEqual(diffAgainstBaseline([], [findings[0].key]).removed, [findings[0].key])
})

test("the committed baseline still matches the repository", () => {
  // The gate's whole value is this equality. If it drifts, either a call site
  // was fixed (rerun with --write-baseline) or a new mismatch landed.
  assert.deepEqual(diffAgainstBaseline(collectRepositoryFindings(), readBaseline()).added, [])
})

test("omitting all arguments still reports required wire parameters", () => {
  const commands = new Map([["demo", command("demo", [{ name: "required_id", type: "String" }])]])
  for (const source of ['invoke("demo")', 'invoke("demo", {})']) {
    const findings = analyze(site(source), commands)
    assert.equal(findings.length, 1)
    assert.match(findings[0].key, /missing-argument:required_id$/)
  }
})

test("omitted, trailing-comma, and undefined arguments match an empty object", () => {
  const commands = new Map([["x", command("x", [{ name: "required_id", type: "String" }])]])
  for (const source of ['invoke("x",)', 'invoke("x", undefined)', 'invoke("x", /* empty */ {})']) {
    assert.match(analyze(site(source), commands)[0].key, /missing-argument:required_id$/)
  }
  assert.deepEqual(analyze(site('invoke("x")'), new Map([["x", command("x", [])]])), [])
})

test("comments, strings, and regex literals are not invoke calls", () => {
  const source = `// invoke("x", { bogus: true })
    /* invoke("x") */
    const example = 'invoke("x", {})';
    const pattern = /invoke("x")/;
    invoke("real", { value: /[,}]/, text: "{ nested }" });`
  assert.deepEqual(
    site(source).map((call) => call.command),
    ["real"]
  )
  assert.deepEqual(site(source)[0].keys, ["value", "text"])
})

test("nested generics and TypeScript argument wrappers retain literal keys", () => {
  const found = site('invoke<Promise<Array<{id: string}>>>("x", ({ id } as const) satisfies Args)')
  assert.equal(found[0].kind, "object")
  assert.deepEqual(found[0].keys, ["id"])
})

test("computed keys cannot manufacture missing-field findings", () => {
  const commands = new Map([["x", command("x", [{ name: "required_id", type: "String" }])]])
  assert.deepEqual(analyze(site('invoke("x", { [key]: value })'), commands), [])
  assert.deepEqual(analyze(site('invoke("x", { ["requiredId"]: value })'), commands), [])
  const findings = analyze(site('invoke("x", { [key]: value, bogus: true })'), commands)
  assert.equal(findings.length, 1)
  assert.match(findings[0].key, /unknown-argument:bogus$/)
})

test("fixed notification payload is checked using fixtures, not historical baseline debt", () => {
  const commands = new Map([
    [
      "plugin_show_notification",
      command("plugin_show_notification", [{ name: "args", type: "ShowNotificationArgs" }]),
    ],
  ])
  const flat = analyze(site('invoke("plugin_show_notification", { title: "hi" })'), commands)
  assert.equal(flat.length, 2)
  assert.ok(flat.some((finding) => finding.key.endsWith("missing-argument:args")))
  assert.deepEqual(
    analyze(site('invoke("plugin_show_notification", { args: { title: "hi" } })'), commands),
    []
  )
})

test("registration selection ignores paths outside the actual handler", () => {
  const selected = { ...command("demo", []), file: "src-tauri/src/right/commands.rs" }
  const wrong = {
    ...command("demo", [{ name: "bogus", type: "String" }]),
    file: "crates/wrong/src/commands.rs",
  }
  const source = `use wrong::demo;
    // wrong::demo,
    tauri::generate_handler![right::demo, bare,]
    fn helper() { let _ = wrong::demo; }`
  assert.deepEqual(
    [
      ...selectRegisteredCommands(
        [wrong, selected, command("bare", []), command("unused", [])],
        source
      ).keys(),
    ],
    ["demo", "bare"]
  )
  assert.equal(
    selectRegisteredCommands([wrong, selected, command("bare", [])], source).get("demo"),
    selected
  )
})

test("ambiguous registered definitions fail loudly instead of picking file order", () => {
  const candidates = ["a", "b"].map((name) => ({
    ...command("demo", []),
    file: `crates/${name}/src/lib.rs`,
  }))
  assert.throws(
    () => selectRegisteredCommands(candidates, "tauri::generate_handler![demo]"),
    /Ambiguous registered command/
  )
  assert.throws(() => selectRegisteredCommands(candidates, "fn main() {}"), /Could not locate/)
})

test("conditional command attributes retain wire params and original line numbers", () => {
  const source = `#[cfg_attr(feature = "tauri-host", tauri::command)]
pub async fn conditional(app: tauri::AppHandle, required_id: String, extra: Option<Vec<String>>) {}
#[cfg_attr(any(feature = "desktop-host", test), tauri::command(rename_all = "snake_case"))]
pub fn desktop(value: Vec<(String, String)>) {}
#[cfg_attr(feature = "other", derive(Debug))]
pub fn ordinary(value: String) {}`
  const parsed = parseInvokeCommands(source, "crates/example/src/lib.rs")
  assert.deepEqual(
    parsed.map(({ name, line }) => ({ name, line })),
    [
      { name: "conditional", line: 1 },
      { name: "desktop", line: 3 },
    ]
  )
  assert.deepEqual(parsed[0].params, [
    { name: "required_id", type: "String" },
    { name: "extra", type: "Option<Vec<String>>" },
  ])
  assert.match(
    analyze(site('invoke("conditional")'), new Map([["conditional", parsed[0]]]))[0].key,
    /missing-argument:required_id$/
  )
})

test("SFTP macro fields become command params, not the dispatcher envelope", () => {
  const source = `desktop_sftp_command!(
    sftp_example, "sftp_example",
    [profile_id as "profileId": String, entries as "entries": Vec<(String, String)>,
      optional as "optional": Option<String>]
  );`
  const [parsed] = parseInvokeCommands(source, "src-tauri/src/sftp_service.rs")
  assert.equal(parsed.name, "sftp_example")
  assert.equal(parsed.line, 1)
  assert.deepEqual(
    parsed.params.map((p) => p.name),
    ["profile_id", "entries", "optional"]
  )
  assert.deepEqual(
    analyze(
      site('invoke("sftp_example", { profileId, entries })'),
      new Map([[parsed.name, parsed]])
    ),
    []
  )
  assert.throws(
    () =>
      parseInvokeCommands(
        'desktop_sftp_command!(bad, "bad", [not_a_typed_field]);',
        "src-tauri/src/sftp_service.rs"
      ),
    /Unsupported SFTP/
  )
})

test("unresolved registrations fail instead of silently reducing coverage", () => {
  assert.throws(
    () => selectRegisteredCommands([], "tauri::generate_handler![module::missing]"),
    /Unresolved registered command module::missing/
  )
})

test("the task workspace re-export resolves the duplicate only with owner evidence", () => {
  const owner = {
    ...command("git_worktree_remove", []),
    file: "crates/cognia-task-workspace-host/src/host_surface.rs",
  }
  const other = {
    ...command("git_worktree_remove", [{ name: "wrong", type: "String" }]),
    file: "crates/cognia-git/src/commands.rs",
  }
  const source = "tauri::generate_handler![task_workspace::git_worktree_remove]"
  const sources = new Map([
    ["src-tauri/src/task_workspace.rs", "pub use cognia_task_workspace_host::host_surface::*;"],
  ])
  const owners = verifiedRegistrationOwners(sources)
  assert.equal(selectRegisteredCommands([other, owner], source, owners).get(owner.name), owner)
  assert.throws(() => selectRegisteredCommands([other], source, owners), /Ambiguous/)
  assert.throws(
    () => selectRegisteredCommands([owner, other], source, verifiedRegistrationOwners(new Map())),
    /Ambiguous/
  )
  assert.throws(
    () =>
      selectRegisteredCommands(
        [owner, other],
        source,
        verifiedRegistrationOwners(
          new Map([
            [
              "src-tauri/src/task_workspace.rs",
              "// pub use cognia_task_workspace_host::host_surface::*;\npub use elsewhere::*;",
            ],
          ])
        )
      ),
    /Ambiguous/
  )
})

test("multiline conditional attributes preserve following command diagnostics", () => {
  const source = `#[cfg_attr(
  feature = "tauri-host",
  tauri::command(
    rename_all = "snake_case"
  )
)]
pub fn first(value: String) {}
#[tauri::command]
pub fn second(value: String) {}`
  assert.deepEqual(
    parseInvokeCommands(source, "x.rs").map((c) => [c.name, c.line]),
    [
      ["first", 1],
      ["second", 8],
    ]
  )
})

test("every current Tauri registration has a signature, including conditional and macro owners", () => {
  const commands = collectRegisteredCommands()
  assert.ok(commands.size >= 1204, `expected full registration inventory, got ${commands.size}`)
  assert.equal(
    commands.get("git_worktree_remove").file,
    "crates/cognia-task-workspace-host/src/host_surface.rs"
  )
  assert.deepEqual(
    commands.get("sftp_delete_entry").params.map((p) => p.name),
    ["profile_id", "path", "is_dir"]
  )
})
