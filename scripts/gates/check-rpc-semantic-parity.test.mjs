import assert from "node:assert/strict"
import test from "node:test"

import {
  analyze,
  collectChannelReferences,
  collectEmittedChannels,
  matchesEventCatalog,
  parseEventChannelCatalog,
  stripRustTestModules,
  armNamesOnLine,
  armReadFields,
  acceptedPropertyNames,
  armRequiredFields,
  consumesWholeArgs,
  diffAgainstBaseline,
  extractBalanced,
  extractDispatchArms,
  isBridgeArm,
  isChannelParam,
  isInjectedParam,
  isOpaqueSchema,
  ceilingRegressions,
  GATED_KINDS,
  countRatchetedKinds,
  responseSchemaPrecision,
  normalizeField,
  parseDispositionNames,
  parsePublicSpecRequestSchemas,
  parseTauriCommands,
  requiresHeadless,
  schemaProperties,
  splitParams,
  stripRustComments,
} from "./check-rpc-semantic-parity.mjs"

// ---------------------------------------------------------------------------
// Rust source parsing
// ---------------------------------------------------------------------------

test("stripRustComments keeps string literals but drops comments", () => {
  assert.equal(
    stripRustComments('let a = "// not a comment"; // gone'),
    'let a = "// not a comment"; '
  )
  assert.equal(stripRustComments("a /* b */ c"), "a  c")
  assert.equal(stripRustComments("a /* b /* nested */ still */ c"), "a  c")
})

test("extractBalanced handles nesting", () => {
  const src = "fn f(a: State<'_, T>, b: (u8, u8)) -> X"
  const block = extractBalanced(src, src.indexOf("("), "(", ")")
  assert.equal(block.text, "a: State<'_, T>, b: (u8, u8)")
})

test("splitParams does not shred generics or tuples", () => {
  assert.deepEqual(splitParams("state: State<'_, ApiKeyState>, key: Option<String>"), [
    "state: State<'_, ApiKeyState>",
    "key: Option<String>",
  ])
  assert.deepEqual(splitParams("a: Vec<(String, String)>, b: u8"), [
    "a: Vec<(String, String)>",
    "b: u8",
  ])
})

test("injected and channel params are classified apart", () => {
  assert.ok(isInjectedParam("State<'_, ApiKeyState>"))
  assert.ok(isInjectedParam("AppHandle"))
  assert.ok(isInjectedParam("tauri::AppHandle<R>"))
  assert.ok(isInjectedParam("WebviewWindow"))
  assert.ok(!isInjectedParam("Option<String>"))
  // Channel is injected by Tauri too, but it marks a STREAMING command — the
  // whole point is that it must NOT be silently treated as a non-param.
  assert.ok(isChannelParam("Channel<SeqEvent>"))
  assert.ok(isChannelParam("tauri::ipc::Channel<Value>"))
  assert.ok(!isChannelParam("String"))
})

test("parseTauriCommands reads real wire params past comments and injected state", () => {
  const source = `
/// Doc comment.
#[tauri::command]
async fn claude_set_provider_env(
    state: State<'_, ApiKeyState>,
    api_key: Option<String>,
    base_url: Option<String>,
    // Ordered \`[name, value]\` pairs forwarded as ANTHROPIC_CUSTOM_HEADER_*.
    custom_headers: Option<Vec<(String, String)>>,
) -> Result<(), String> {
    Ok(())
}
`
  const [command] = parseTauriCommands(source, "src-tauri/src/lib.rs")
  assert.equal(command.name, "claude_set_provider_env")
  assert.deepEqual(
    command.params.map((p) => p.name),
    ["api_key", "base_url", "custom_headers"]
  )
  assert.equal(command.returnType, "Result<(), String>")
})

test("parseTauriCommands separates Channel params from wire params", () => {
  const source = `
#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    cwd: Option<String>,
    on_event: Channel<SeqEvent>,
) -> Result<String, String> { todo!() }
`
  const [command] = parseTauriCommands(source, "x.rs")
  assert.deepEqual(
    command.params.map((p) => p.name),
    ["cwd"]
  )
  assert.deepEqual(command.channelParams, ["on_event"])
})

// ---------------------------------------------------------------------------
// Dispatch-arm parsing
// ---------------------------------------------------------------------------

test("armNamesOnLine reads BOTH names of a same-line or-pattern", () => {
  // The regression that made 7 commands look arm-less (a phantom runtime 404).
  assert.deepEqual(armNamesOnLine('        "secret_store_get" | "keyring_secret_get" => {'), [
    "secret_store_get",
    "keyring_secret_get",
  ])
  // String literals in the arm BODY are not names.
  assert.deepEqual(armNamesOnLine('        "mcp_server_start" => dispatch("jobs.read")'), [
    "mcp_server_start",
  ])
})

test("extractDispatchArms handles both or-pattern spellings and stops at the wildcard", () => {
  const source = `
pub(super) async fn dispatch(name: &str) -> Result<Value, RpcError> {
    let result = match name {
        "alpha" => Ok(Value::Null),
        "beta" | "gamma" => {
            let x: String = required(&args, "x")?;
            Ok(Value::Null)
        }
        "delta"
        | "epsilon" => Ok(Value::Null),
        _ => Err(RpcError::unknown_command(name)),
    };
}
`
  const arms = extractDispatchArms(source, "rpc/x.rs")
  assert.deepEqual(
    arms.flatMap((a) => a.names),
    ["alpha", "beta", "gamma", "delta", "epsilon"]
  )
})

test("extractDispatchArms ignores a match on `name` outside the dispatch fn", () => {
  // source_control.rs matches on `name` inside prepare_remote_args too;
  // attributing that body to the git commands would be silently wrong.
  const source = `
fn prepare_remote_args(name: &str) {
    let relative_key = match name {
        "decoy" => "a",
        _ => "b",
    };
}
pub(super) async fn dispatch(name: &str) {
    let result = match name {
        "real" => Ok(()),
        _ => Err(()),
    };
}
`
  const arms = extractDispatchArms(source, "rpc/source_control.rs")
  assert.deepEqual(
    arms.flatMap((a) => a.names),
    ["real"]
  )
})

test("armReadFields covers every field-reader spelling, aliases included", () => {
  const body = `
    let a: String = required(&args, "plugin_id")?;
    let b: Option<String> = optional(&args, "base_url")?;
    let c: String = required_aliased(&args, "manifest_json", "manifestJson")?;
    let d = args.get("raw_field").and_then(|v| v.as_str());
  `
  assert.deepEqual(
    [...armReadFields(body)].sort(),
    ["base_url", "manifest_json", "manifestJson", "plugin_id", "raw_field"].sort()
  )
})

test("consumesWholeArgs recognises whole-blob hand-offs but not field reads", () => {
  // Struct deserialization — automation_consent_respond.
  assert.ok(consumesWholeArgs("let a: ConsentRespondArgs = serde_json::from_value(args)?;"))
  // Downstream forwarding — the background_job_* family.
  assert.ok(consumesWholeArgs('crate::jobs::dispatch_host_rpc("jobs.read", &args).await'))
  // A field reader also takes `&args`, and must NOT count: treating it as a
  // whole-blob hand-off would blind the gate to every real truncation.
  assert.ok(!consumesWholeArgs('let x: String = required(&args, "job_id")?;'))
  assert.ok(!consumesWholeArgs('let y: Option<u64> = optional(&args, "max_bytes")?;'))
})

test("armRequiredFields returns only hard-required reads, with aliases", () => {
  const body = `
    let a: String = required_aliased(&args, "session_id", "sessionId")?;
    let b: Option<String> = optional(&args, "message")?;
    let c: Ctx = required(&args, "remote_execution_context")?;
    let d = args.get("loose");
  `
  // optional reads and raw args.get are deliberately excluded: only a REQUIRED
  // field the schema forbids can deadlock a command.
  assert.deepEqual(armRequiredFields(body), [
    ["session_id", "sessionId"],
    ["remote_execution_context", undefined],
  ])
})

test("flags a contract deadlock: arm requires what the enforced schema forbids", () => {
  const findings = analyze(
    baseInput({
      arms: new Map([
        [
          "claude_approve",
          {
            body: 'let c: Ctx = required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;',
            file: "rpc/chat.rs",
          },
        ],
      ]),
      catalog: new Map([
        [
          "claude_approve",
          {
            inputSchema: {
              properties: { session_id: {}, decision: {} },
              additionalProperties: false,
            },
            outputSchema: {},
          },
        ],
      ]),
    })
  )
  const deadlocks = findings.filter((f) => f.kind === "deadlocked-contract")
  assert.equal(deadlocks.length, 1)
  assert.match(deadlocks[0].detail, /remote_execution_context/)
})

test("no deadlock when the schema declares the field, or under either spelling", () => {
  const arm = new Map([
    [
      "cmd",
      {
        body: 'required_aliased(&args, "remote_execution_context", "remoteExecutionContext")?;',
        file: "rpc/x.rs",
      },
    ],
  ])
  const withCamel = analyze(
    baseInput({
      arms: arm,
      catalog: new Map([
        [
          "cmd",
          {
            inputSchema: {
              properties: { remoteExecutionContext: {} },
              additionalProperties: false,
            },
            outputSchema: {},
          },
        ],
      ]),
    })
  )
  assert.deepEqual(
    withCamel.filter((f) => f.kind === "deadlocked-contract"),
    []
  )
  // An open schema cannot deadlock: the extra property is simply accepted.
  const openSchema = analyze(
    baseInput({
      arms: arm,
      catalog: new Map([["cmd", { inputSchema: { properties: {} }, outputSchema: {} }]]),
    })
  )
  assert.deepEqual(
    openSchema.filter((f) => f.kind === "deadlocked-contract"),
    []
  )
})

test("isBridgeArm and requiresHeadless classify the two host-shaped arms", () => {
  assert.ok(isBridgeArm("desktop_writes_bridge(name, args).await"))
  assert.ok(!isBridgeArm('desktop_writes_bridge(name, required(&args, "id")?).await'))
  assert.ok(
    requiresHeadless(
      "let s = host.headless().ok_or_else(|| RpcError::headless_unsupported(name))?;"
    )
  )
  assert.ok(!requiresHeadless("let app = host.tauri_app(name)?;"))
})

// ---------------------------------------------------------------------------
// Contract artifacts
// ---------------------------------------------------------------------------

test("normalizeField makes the two naming conventions comparable", () => {
  assert.equal(normalizeField("api_key"), normalizeField("apiKey"))
  assert.equal(
    normalizeField("destination_relative_path"),
    normalizeField("destinationRelativePath")
  )
  assert.notEqual(normalizeField("job_id"), normalizeField("jobs"))
})

test("parseDispositionNames reads every group, and refuses to parse to nothing", () => {
  const ledger = {
    schemaVersion: 1,
    groups: [
      { disposition: "local-only", reason: "…", commands: ["open_tray_panel"] },
      { disposition: "covered-by-headless", reason: "…", commands: ["scheduler_arm_task"] },
    ],
  }
  assert.deepEqual([...parseDispositionNames(ledger)].sort(), [
    "open_tray_panel",
    "scheduler_arm_task",
  ])
  // A shape change must be loud. Returning an empty set here would make every
  // triaged command look untriaged — the silent-empty failure this gate exists
  // to catch, reproduced inside the gate itself.
  assert.throws(() => parseDispositionNames({ schemaVersion: 1, commands: [] }), /zero commands/)
  assert.throws(() => parseDispositionNames({}), /zero commands/)
})

test("parsePublicSpecRequestSchemas pulls the /api/_rpc request properties", () => {
  const yaml = [
    "paths:",
    "  /api/_rpc/git_clone:",
    "    post:",
    "      requestBody:",
    "        content:",
    "          application/json:",
    "            schema:",
    "              type: object",
    "              properties:",
    "                remoteUrl:",
    "                  type: string",
    "                workspaceId:",
    "                  type: string",
    "  /api/_rpc/git_status:",
    "    post:",
    "      requestBody:",
    "        content:",
    "          application/json:",
    "            schema:",
    "              properties:",
    "                relativePath:",
    "                  type: string",
  ].join("\n")
  const parsed = parsePublicSpecRequestSchemas(yaml)
  assert.deepEqual([...parsed.keys()].sort(), ["git_clone", "git_status"])
  assert.deepEqual(Object.keys(parsed.get("git_clone").properties), ["remoteUrl", "workspaceId"])
  // The second path must not absorb the first one's properties.
  assert.deepEqual(Object.keys(parsed.get("git_status").properties), ["relativePath"])
})

test("flags a published request shape the enforced schema would reject", () => {
  // The git_* outage in miniature: the spec documents workspace coordinates,
  // the enforced catalog demands a resolved path, and validation runs first.
  const findings = analyze(
    baseInput({
      publicSpecSchemas: new Map([
        [
          "git_clone",
          { properties: { remoteUrl: {}, workspaceId: {}, destinationRelativePath: {} } },
        ],
      ]),
      catalog: new Map([
        [
          "git_clone",
          {
            inputSchema: {
              properties: { remoteUrl: {}, destination: {} },
              additionalProperties: false,
            },
            outputSchema: {},
          },
        ],
      ]),
    })
  )
  const mismatch = findings.filter((f) => f.kind === "published-shape-not-enforced")
  assert.equal(mismatch.length, 1)
  assert.match(mismatch[0].detail, /2 propert/)
})

test("a device-plane override satisfies the published shape", () => {
  // Same command, but the runtime now validates the device plane against the
  // overlay — which is exactly what the published spec documents.
  const findings = analyze(
    baseInput({
      publicSpecSchemas: new Map([
        [
          "git_clone",
          { properties: { remoteUrl: {}, workspaceId: {}, destinationRelativePath: {} } },
        ],
      ]),
      devicePlaneOverrides: new Map([
        [
          "git_clone",
          { properties: { remoteUrl: {}, workspaceId: {}, destinationRelativePath: {} } },
        ],
      ]),
      catalog: new Map([
        [
          "git_clone",
          {
            inputSchema: {
              properties: { remoteUrl: {}, destination: {} },
              additionalProperties: false,
            },
            outputSchema: {},
          },
        ],
      ]),
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "published-shape-not-enforced"),
    []
  )
})

test("host-chosen parameter exemptions suppress findings but cannot go stale", () => {
  const exemptions = {
    "mcp_oauth_refresh.helper_path": "names a binary the host executes",
  }
  const withParam = analyze(
    baseInput({
      hostChosenParams: exemptions,
      tauriCommands: new Map([["mcp_oauth_refresh", command(["server_name", "helper_path"])]]),
      arms: new Map([
        [
          "mcp_oauth_refresh",
          { body: 'required(&args, "server_name")?;', file: "rpc/native_tools.rs" },
        ],
      ]),
    })
  )
  // helper_path names a binary the host executes — withheld on purpose.
  assert.deepEqual(
    withParam.filter((f) => f.kind === "missing-params"),
    []
  )
  // If the command stops declaring it, the written reason must not survive.
  const withoutParam = analyze(
    baseInput({
      hostChosenParams: exemptions,
      tauriCommands: new Map([["mcp_oauth_refresh", command(["server_name"])]]),
    })
  )
  assert.match(
    withoutParam.find((f) => f.kind === "stale-host-chosen-exemption")?.detail ?? "",
    /no longer declares `helper_path`/
  )
})

test("acceptedPropertyNames follows discriminated unions", () => {
  // twin_profile_update is a Zod discriminatedUnion: its properties live in
  // the branches, so a top-level lookup finds none and reports the entire
  // documented request as rejected.
  const union = {
    anyOf: [
      { properties: { twinId: {}, op: {}, voiceSummary: {} } },
      { properties: { twinId: {}, op: {}, entity: {} } },
    ],
  }
  assert.deepEqual([...acceptedPropertyNames(union)].sort(), [
    "entity",
    "op",
    "twinId",
    "voiceSummary",
  ])
  assert.deepEqual([...acceptedPropertyNames({ properties: { a: {} } })], ["a"])
  assert.deepEqual([...acceptedPropertyNames(null)], [])
})

test("parsePublicSpecRequestSchemas ignores the response error envelope", () => {
  // A no-arg command has no request properties; the first `properties:` in its
  // path block belongs to the error response, whose code/message/retryable
  // would otherwise be reported as rejected request fields.
  const yaml = [
    "paths:",
    "  /api/_rpc/claude_has_api_key:",
    "    post:",
    "      requestBody:",
    "        content:",
    "          application/json:",
    "            schema:",
    "              type: object",
    "      responses:",
    "        '400':",
    "          content:",
    "            application/json:",
    "              schema:",
    "                properties:",
    "                  code:",
    "                    type: string",
    "                  message:",
    "                    type: string",
    "                  retryable:",
    "                    type: boolean",
  ].join("\n")
  assert.equal(parsePublicSpecRequestSchemas(yaml).has("claude_has_api_key"), false)
})

test("schemaProperties and isOpaqueSchema identify vacuous schemas", () => {
  assert.deepEqual(schemaProperties({ properties: { a: {}, b: {} } }), ["a", "b"])
  assert.equal(schemaProperties({ type: "object" }), null)
  // LegacyResult: matches any JSON, so validating against it proves nothing.
  assert.ok(isOpaqueSchema({ type: ["object", "array", "string", "number", "boolean", "null"] }))
  assert.ok(!isOpaqueSchema({ type: "object", properties: { workspaceId: {} } }))
  // `LegacyRecord` DOES reject a non-object, so it is weak, not vacuous.
  assert.ok(!isOpaqueSchema({ type: "object" }))
})

test("responseSchemaPrecision separates vacuous from merely weak from precise", () => {
  const legacyResult = { type: ["object", "array", "string", "number", "boolean", "null"] }

  // Vacuous — every JSON value passes.
  assert.equal(responseSchemaPrecision(legacyResult), "any")
  assert.equal(responseSchemaPrecision(undefined), "any")
  assert.equal(responseSchemaPrecision({}), "any")

  // Root type pinned, contents unconstrained: `LegacyRecord` / `LegacyList`.
  assert.equal(responseSchemaPrecision({ type: "object", additionalProperties: true }), "container")
  assert.equal(responseSchemaPrecision({ type: "array", items: legacyResult }), "container")
  assert.equal(responseSchemaPrecision({ type: "array" }), "container")

  // Precise. `{"type":"null"}` is the tightest schema expressible — grading it
  // as unvalidated is what inflated the reported debt from 325 to 466.
  assert.equal(responseSchemaPrecision({ type: "null" }), "precise")
  assert.equal(responseSchemaPrecision({ type: "boolean" }), "precise")
  assert.equal(responseSchemaPrecision({ type: "string" }), "precise")
  assert.equal(responseSchemaPrecision({ type: "object", properties: { a: {} } }), "precise")
  // A union grades as its most permissive member, so a nullable object with no
  // declared properties is still only container-grade...
  assert.equal(responseSchemaPrecision({ type: ["object", "null"] }), "container")
  // ...while a union of scalars admits a bounded set of values.
  assert.equal(responseSchemaPrecision({ type: ["string", "null"] }), "precise")
  // Composed and typed-item schemas carry no top-level `properties`, and were
  // both misfiled as opaque by the property-presence test (`perf_open_lease`,
  // `perf_read_observations`).
  assert.equal(responseSchemaPrecision({ oneOf: [{ type: "object" }] }), "precise")
  assert.equal(
    responseSchemaPrecision({ type: "array", items: { type: "object", properties: { a: {} } } }),
    "precise"
  )
})

test("the response-schema ratchet fails on a rise and stays quiet on a fall", () => {
  const findings = [
    { kind: "opaque-response-schema" },
    { kind: "opaque-response-schema" },
    { kind: "unconstrained-response-contents" },
    { kind: "missing-params" },
  ]
  assert.deepEqual(countRatchetedKinds(findings), {
    "opaque-response-schema": 2,
    "unconstrained-response-contents": 1,
  })

  const counts = countRatchetedKinds(findings)
  // At the ceiling, and below it, are both fine.
  assert.deepEqual(
    ceilingRegressions(counts, {
      "opaque-response-schema": 2,
      "unconstrained-response-contents": 1,
    }),
    []
  )
  assert.deepEqual(
    ceilingRegressions(counts, {
      "opaque-response-schema": 9,
      "unconstrained-response-contents": 9,
    }),
    []
  )
  // One more untyped response than last time fails the gate.
  assert.deepEqual(ceilingRegressions(counts, { "opaque-response-schema": 1 }), [
    { kind: "opaque-response-schema", current: 2, ceiling: 1 },
  ])
  // A kind with no recorded ceiling cannot regress — it has no prior.
  assert.deepEqual(ceilingRegressions(counts, {}), [])
})

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function baseInput(overrides = {}) {
  return {
    tauriCommands: new Map(),
    registered: new Set(),
    knownCommands: new Set(),
    serviceOnly: new Set(),
    arms: new Map(),
    catalog: new Map(),
    manifestNames: new Set(),
    dispositionNames: new Set(),
    browserCommands: new Set(),
    // The documented-exemption tables default to EMPTY here, not to the
    // production ones. A test that builds a two-command inventory around
    // `terminal_spawn` would otherwise be silently exempted by the real table
    // and assert nothing — and the staleness rules would fire against the
    // fixture's missing commands on top of it.
    hostChosenParams: {},
    streamReplacements: {},
    headlessOwnedArms: {},
    ...overrides,
  }
}

const command = (params, extra = {}) => ({
  file: "src-tauri/src/lib.rs",
  line: 1,
  params: params.map((name) => ({ name, type: "String" })),
  channelParams: [],
  returnType: "Result<(), String>",
  ...extra,
})

test("flags a dispatch arm that drops an argument", () => {
  const findings = analyze(
    baseInput({
      tauriCommands: new Map([["claude_set_provider_env", command(["api_key", "custom_headers"])]]),
      arms: new Map([
        [
          "claude_set_provider_env",
          { body: 'let k: Option<String> = optional(&args, "api_key")?;', file: "rpc/chat.rs" },
        ],
      ]),
    })
  )
  const missing = findings.filter((f) => f.kind === "missing-params")
  assert.equal(missing.length, 1)
  assert.match(missing[0].detail, /custom_headers/)
})

test("does not flag an arm that forwards the whole args blob", () => {
  const findings = analyze(
    baseInput({
      tauriCommands: new Map([["background_job_read", command(["job_id", "max_bytes"])]]),
      arms: new Map([
        [
          "background_job_read",
          { body: 'dispatch_host_rpc("jobs.read", &args).await', file: "rpc/data_sync.rs" },
        ],
      ]),
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "missing-params"),
    []
  )
})

test("flags a contract schema narrower than the command it fronts", () => {
  const findings = analyze(
    baseInput({
      tauriCommands: new Map([["claude_set_mode", command(["session_id", "command_id"])]]),
      catalog: new Map([
        ["claude_set_mode", { inputSchema: { properties: { sessionId: {} } }, outputSchema: {} }],
      ]),
    })
  )
  const schemaGaps = findings.filter((f) => f.kind === "schema-missing-params")
  assert.equal(schemaGaps.length, 1)
  assert.match(schemaGaps[0].detail, /command_id/)
})

test("browser commands are not reported as arm-less", () => {
  // They dispatch through the typed browser gateway before the match table.
  const findings = analyze(
    baseInput({
      knownCommands: new Set(["browser_navigate", "chat_send"]),
      browserCommands: new Set(["browser_navigate"]),
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "known-command-without-arm").map((f) => f.command),
    ["chat_send"]
  )
})

test("flags an arm the allowlist does not admit, and a Tauri command nobody triaged", () => {
  const findings = analyze(
    baseInput({
      registered: new Set(["dsh_runtime_facts"]),
      arms: new Map([["plugin_wasm_renderer_response", { body: "", file: "rpc/plugins.rs" }]]),
    })
  )
  assert.deepEqual(findings.map((f) => f.key).sort(), [
    "dsh_runtime_facts:unregistered-command",
    "plugin_wasm_renderer_response:arm-not-allowlisted",
  ])
})

test("a device-reachable arm that needs headless services is desktop-dead", () => {
  const headlessBody = "host.headless().ok_or_else(|| RpcError::headless_unsupported(name))?"
  const findings = analyze(
    baseInput({
      knownCommands: new Set(["codeserver_ensure", "connectors_start"]),
      serviceOnly: new Set(["connectors_start"]),
      arms: new Map([
        ["codeserver_ensure", { body: headlessBody, file: "rpc/plugins.rs" }],
        ["connectors_start", { body: headlessBody, file: "rpc/service_plane.rs" }],
      ]),
    })
  )
  // Only the one a paired device can actually reach is a user-visible defect.
  assert.deepEqual(
    findings.filter((f) => f.kind === "desktop-dead").map((f) => f.command),
    ["codeserver_ensure"]
  )
})

test("a Channel command with no RPC path is reported", () => {
  const findings = analyze(
    baseInput({
      registered: new Set(["tts_realtime_synthesize"]),
      manifestNames: new Set(["tts_realtime_synthesize"]),
      tauriCommands: new Map([
        ["tts_realtime_synthesize", command(["text"], { channelParams: ["on_event"] })],
      ]),
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "channel-command-excluded").map((f) => f.command),
    ["tts_realtime_synthesize"]
  )
})

// ---------------------------------------------------------------------------
// Documented exemptions
// ---------------------------------------------------------------------------

test("a stream command with a recorded replacement is not reported", () => {
  const input = baseInput({
    registered: new Set(["terminal_spawn", "tts_realtime_synthesize"]),
    tauriCommands: new Map([
      ["terminal_spawn", command(["cwd"], { channelParams: ["on_event"] })],
      ["tts_realtime_synthesize", command(["text"], { channelParams: ["on_event"] })],
    ]),
    streamReplacements: { terminal_spawn: "replaced by /ws/terminal" },
  })
  assert.deepEqual(
    analyze(input)
      .filter((f) => f.kind === "channel-command-excluded")
      .map((f) => f.command),
    ["tts_realtime_synthesize"]
  )
})

test("a stream exemption goes stale when the command stops streaming", () => {
  const findings = analyze(
    baseInput({
      registered: new Set(["terminal_spawn"]),
      // No Channel param any more — the command is now plain-dispatchable, so
      // the exemption is asserting something that is no longer true.
      tauriCommands: new Map([["terminal_spawn", command(["cwd"])]]),
      streamReplacements: { terminal_spawn: "replaced by /ws/terminal" },
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "stale-stream-exemption").map((f) => f.command),
    ["terminal_spawn"]
  )
})

test("a stream exemption goes stale when the command gains an RPC path", () => {
  const findings = analyze(
    baseInput({
      registered: new Set(["terminal_spawn"]),
      knownCommands: new Set(["terminal_spawn"]),
      tauriCommands: new Map([
        ["terminal_spawn", command(["cwd"], { channelParams: ["on_event"] })],
      ]),
      streamReplacements: { terminal_spawn: "replaced by /ws/terminal" },
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "stale-stream-exemption").map((f) => f.command),
    ["terminal_spawn"]
  )
})

test("a headless-owned arm is not reported as desktop-dead, but a bare one is", () => {
  const headlessArm = {
    body: "let services = host.headless().ok_or_else(|| RpcError::headless_host_required(name))?;",
    file: "rpc/plugins.rs",
  }
  const findings = analyze(
    baseInput({
      arms: new Map([
        ["codeserver_ensure", headlessArm],
        ["something_else", headlessArm],
      ]),
      headlessOwnedArms: { codeserver_ensure: "the remote host owns the instance" },
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "desktop-dead").map((f) => f.command),
    ["something_else"]
  )
})

test("desktop-dead fails the build rather than merely being reported", () => {
  // The class is at zero and every arm has been routed through `DispatchHost`.
  // Report-only was right while there was a backlog; keeping it report-only
  // afterwards is how 17 findings come back one arm at a time with a green
  // gate. This assertion is the thing that stops that.
  assert.ok(GATED_KINDS.has("desktop-dead"))

  const findings = analyze(
    baseInput({
      arms: new Map([
        [
          "codeserver_ensure",
          {
            body: "let services = host.headless().ok_or_else(|| RpcError::headless_host_required(name))?;",
            file: "rpc/plugins.rs",
          },
        ],
      ]),
    })
  )
  const gated = findings.filter((f) => GATED_KINDS.has(f.kind)).map((f) => f.kind)
  assert.ok(gated.includes("desktop-dead"))
})

test("a headless-owned exemption goes stale when the arm stops needing headless", () => {
  const findings = analyze(
    baseInput({
      arms: new Map([
        ["codeserver_ensure", { body: "to_json(local_thing())", file: "rpc/plugins.rs" }],
      ]),
      headlessOwnedArms: { codeserver_ensure: "the remote host owns the instance" },
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "stale-headless-owned-exemption").map((f) => f.command),
    ["codeserver_ensure"]
  )
})

// ---------------------------------------------------------------------------
// Disposition ledger
// ---------------------------------------------------------------------------

test("a covered-by-headless claim must name what covers it", () => {
  const findings = analyze(
    baseInput({
      dispositionGroups: [
        {
          disposition: "covered-by-headless",
          reason: "the capability exists elsewhere",
          commands: ["vector_cloud_query", "scheduler_create_task"],
          commandReasons: {
            vector_cloud_query: "the operator reaches their own cloud vector DB directly",
          },
        },
      ],
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "unsubstantiated-coverage-claim").map((f) => f.command),
    ["scheduler_create_task"]
  )
})

test("other dispositions may rely on their shared group reason", () => {
  // Only `covered-by-headless` makes a checkable claim about another surface.
  // `local-only` asserts something about the command itself, which its own
  // reason can carry.
  const findings = analyze(
    baseInput({
      dispositionGroups: [
        {
          disposition: "local-only",
          reason: "depends on the desktop window",
          commands: ["open_tray_panel"],
        },
      ],
    })
  )
  assert.equal(findings.filter((f) => f.kind === "unsubstantiated-coverage-claim").length, 0)
})

// ---------------------------------------------------------------------------
// Event channels
// ---------------------------------------------------------------------------

const CATALOG_FIXTURE = `
pub static EVENT_CHANNELS: &[EventChannelSpec] = &[
    EventChannelSpec {
        pattern: "claude://message",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: true,
        note: "chat stream",
    },
    EventChannelSpec {
        pattern: "connectors://*",
        audience: ChannelAudience::Any,
        default_on: true,
        tauri_forwarded: false,
        note: "family",
    },
    EventChannelSpec {
        pattern: "gateway://decide",
        audience: ChannelAudience::ServiceOnly,
        default_on: false,
        tauri_forwarded: true,
        note: "brain only",
    },
];
`

test("parseEventChannelCatalog reads pattern, default_on and tauri_forwarded", () => {
  const catalog = parseEventChannelCatalog(CATALOG_FIXTURE)
  assert.deepEqual([...catalog.keys()], ["claude://message", "connectors://*", "gateway://decide"])
  assert.deepEqual(catalog.get("claude://message"), { defaultOn: true, tauriForwarded: true })
  assert.deepEqual(catalog.get("connectors://*"), { defaultOn: true, tauriForwarded: false })
  assert.deepEqual(catalog.get("gateway://decide"), { defaultOn: false, tauriForwarded: true })
})

// A parser that quietly returns nothing turns the whole check into a no-op that
// reports success. Both failure modes have to be loud.
test("parseEventChannelCatalog throws rather than returning an empty catalog", () => {
  assert.throws(() => parseEventChannelCatalog("no catalog here"), /parser is stale/)
  assert.throws(
    () => parseEventChannelCatalog("pub static EVENT_CHANNELS: &[X] = &[\n];\n"),
    /zero entries/
  )
})

test("matchesEventCatalog honours trailing-* families the way the Rust does", () => {
  const catalog = parseEventChannelCatalog(CATALOG_FIXTURE)
  assert.equal(matchesEventCatalog(catalog, "claude://message"), true)
  assert.equal(matchesEventCatalog(catalog, "connectors://onebot/a-7/event"), true)
  assert.equal(matchesEventCatalog(catalog, "tray://open-logs"), false)
  // A family entry must not match a name that merely contains its prefix.
  assert.equal(matchesEventCatalog(catalog, "other://connectors://x"), false)
})

test("stripRustTestModules drops cfg(test) blocks and keeps the rest", () => {
  const src = [
    'fn live() { app.emit("real://one", x); }',
    "#[cfg(test)]",
    'mod tests { fn t() { bus.publish("test://a".into(), y); } }',
    'fn after() { app.emit("real://two", z); }',
  ].join("\n")
  const stripped = stripRustTestModules(src)
  assert.match(stripped, /real:\/\/one/)
  assert.match(stripped, /real:\/\/two/)
  assert.doesNotMatch(stripped, /test:\/\/a/)
})

test("collectEmittedChannels ignores fixtures inside cfg(test)", () => {
  const emitted = collectEmittedChannels([
    {
      file: "src-tauri/src/companion_api/event_bus.rs",
      source: [
        'fn go() { bus.publish("notification://remote".to_string(), v); }',
        "#[cfg(test)]",
        'mod tests { fn t() { bus.publish("test://a".into(), v); } }',
      ].join("\n"),
    },
  ])
  assert.deepEqual([...emitted.keys()], ["notification://remote"])
})

test("collectEmittedChannels reads emit, emit_to, publish and emitTo", () => {
  const emitted = collectEmittedChannels([
    { file: "a.rs", source: 'app.emit("git://status-changed", p);' },
    { file: "b.rs", source: 'app.emit_to(LABEL, "fleet://update", p);' },
    { file: "c.rs", source: 'bus.publish_ephemeral_to("perf://frame".to_string(), p, d);' },
    { file: "d.ts", source: 'await emitTo("main", "sync://invalidate", p)' },
  ])
  assert.deepEqual([...emitted.keys()].sort(), [
    "fleet://update",
    "git://status-changed",
    "perf://frame",
    "sync://invalidate",
  ])
})

// The liveness check must not depend on the emit-site scan: most channels are
// emitted through a constant, which no literal scan can follow.
test("collectChannelReferences sees const definitions and template heads", () => {
  const refs = collectChannelReferences([
    { file: "w.rs", source: 'pub const STATUS: &str = "git://status-changed";' },
    { file: "p.ts", source: "emit(`claude://message-${kind}`, payload)" },
    {
      file: "src-tauri/src/companion_api/event_channels.rs",
      source: 'pattern: "ghost://only-in-catalog",',
    },
  ])
  assert.equal(refs.exact.has("git://status-changed"), true)
  assert.deepEqual(refs.prefixes, ["claude://message-"])
  // The catalog itself is excluded, so an entry cannot vouch for itself.
  assert.equal(refs.exact.has("ghost://only-in-catalog"), false)
})

test("a catalog entry nobody names anywhere is reported", () => {
  const findings = analyze(
    baseInput({
      eventCatalog: new Map([
        ["ghost://renamed", { defaultOn: true, tauriForwarded: true }],
        ["claude://message", { defaultOn: true, tauriForwarded: true }],
        ["claude://message-added", { defaultOn: true, tauriForwarded: true }],
        ["connectors://*", { defaultOn: true, tauriForwarded: false }],
      ]),
      channelReferences: {
        exact: new Set(["claude://message"]),
        prefixes: ["claude://message-"],
      },
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "unreferenced-catalog-entry").map((f) => f.command),
    // `claude://message-added` is covered by the template head, and a `*`
    // family is never checked literally.
    ["ghost://renamed"]
  )
})

test("an emitted channel missing from the catalog is reported, host-local ones are not", () => {
  const findings = analyze(
    baseInput({
      eventCatalog: new Map([["connectors://*", { defaultOn: true, tauriForwarded: false }]]),
      emittedChannels: new Map([
        ["plan://status", "lib/agent/plan/notify.ts"],
        ["connectors://onebot/a/event", "crates/cognia-connectors/src/ws_server.rs"],
        ["tray://open-logs", "src-tauri/src/tray/mod.rs"],
        ["selection://stage", "src-tauri/src/selection_toolbar.rs"],
      ]),
    })
  )
  assert.deepEqual(
    findings.filter((f) => f.kind === "uncatalogued-event-channel").map((f) => f.command),
    ["plan://status"]
  )
})

// ---------------------------------------------------------------------------
// Ratchet
// ---------------------------------------------------------------------------

test("diffAgainstBaseline reports only new keys, and notices repaid debt", () => {
  const current = [{ key: "a:missing-params" }, { key: "b:missing-params" }]
  const { added, fixed } = diffAgainstBaseline(current, ["a:missing-params", "c:missing-params"])
  assert.deepEqual(added, ["b:missing-params"])
  assert.deepEqual(fixed, ["c:missing-params"])
})
