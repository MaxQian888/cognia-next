import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireLock,
  attribute,
  configuredMcpServers,
  diffSnapshots,
  inScope,
  isRegenerable,
  normalizeScope,
  parseArgs,
  parsePorcelain,
  validateSchema,
} from "./codex-agent.mjs";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "codex-agent.mjs");
const skillDirectory = dirname(dirname(scriptPath));

// A scripted stand-in for the Codex CLI. Each invocation appends its argv and
// prompt to the capture file and plays the scenario step for that attempt.
const FAKE_CODEX = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const capturePath = process.env.FAKE_CODEX_CAPTURE;
const previous = existsSync(capturePath) ? readFileSync(capturePath, "utf8").split("\\n").filter(Boolean).length : 0;
appendFileSync(capturePath, JSON.stringify({ args, prompt, pid: process.pid }) + "\\n");
const steps = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, "utf8"));
const step = steps[Math.min(previous, steps.length - 1)];
const cwd = args[args.indexOf("--cd") + 1];
const out = args[args.indexOf("--output-last-message") + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "thread.started", thread_id: step.threadId ?? "thread-1" });
emit({ type: "turn.started" });
for (const write of step.writes ?? []) {
  const target = join(cwd, write.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, write.content);
}
for (const link of step.symlinks ?? []) {
  const target = join(cwd, link.path);
  rmSync(target, { force: true });
  symlinkSync(link.target, target);
}
for (const event of step.events ?? []) emit(event);
if (step.sleepMs) await new Promise((done) => setTimeout(done, step.sleepMs));
if (step.final !== undefined && step.final !== null) {
  writeFileSync(out, typeof step.final === "string" ? step.final : JSON.stringify(step.final));
}
if (step.usage) emit({ type: "turn.completed", usage: step.usage });
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.exitCode ?? 0);
`;

const REVIEW_FINAL = { verdict: "approve", summary: "Ship it.", findings: [], next_steps: [] };

function implementFinal(paths) {
  return {
    status: "done",
    summary: "Implemented.",
    files_changed: paths.map((path) => ({ path, change: "modified", reason: "task" })),
    verification: [{ command: "pnpm test -- src/a.test.ts", exit_code: 0, outcome: "passed", notes: "" }],
    blockers: [],
    follow_ups: [],
  };
}

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-test-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const codexHome = join(root, "codex-home");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".codex"));
  mkdirSync(bin);
  mkdirSync(codexHome);
  writeFileSync(join(repo, "src", "a.txt"), "a\n");
  writeFileSync(join(repo, "other.txt"), "other\n");
  writeFileSync(join(repo, ".codex", "config.toml"), '[mcp_servers.context7]\ncommand = "npx"\n');
  writeFileSync(
    join(codexHome, "config.toml"),
    '[mcp_servers]\n\n[mcp_servers.exa]\nurl = "x"\n\n[mcp_servers.node_repl]\ncommand = "n"\n\n[mcp_servers.node_repl.env]\nA = "1"\n',
  );
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  writeFileSync(join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });

  const context = {
    root,
    repo,
    capture: join(root, "capture.jsonl"),
    scenario: join(root, "scenario.json"),
    home: join(root, "jobs"),
    env: {},
  };
  context.env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    CODEX_HOME: codexHome,
    CODEX_AGENT_HOME: context.home,
    CODEX_AGENT_KILL_GRACE_MS: "200",
    CODEX_AGENT_RETRY_DELAY_MS: "10",
    FAKE_CODEX_CAPTURE: context.capture,
    FAKE_CODEX_SCENARIO: context.scenario,
  };
  return context;
}

function scenario(context, steps) {
  writeFileSync(context.scenario, JSON.stringify(steps));
}

function invocations(context) {
  if (!existsSync(context.capture)) return [];
  return readFileSync(context.capture, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function run(context, args, input = "") {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: context.repo,
    encoding: "utf8",
    env: context.env,
    input,
  });
  let output = null;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    // Non-JSON output (errors, plain messages).
  }
  return { ...result, output };
}

function withContext(body) {
  return async () => {
    const context = setup();
    try {
      await body(context);
    } finally {
      rmSync(context.root, { force: true, recursive: true });
    }
  };
}

const optionValue = (args, name) => args[args.indexOf(name) + 1];

// A detached process group led by a live `sleep`.
function spawnGroup() {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

// A detached group whose leader already exited, leaving a descendant behind:
// what an exited Codex leaves when one of its commands survives.
async function spawnLeaderlessGroup() {
  const child = spawn("sh", ["-c", "sleep 30 & exit 0"], { detached: true, stdio: "ignore" });
  await new Promise((done) => child.on("close", done));
  return child.pid;
}

// A detached process that takes a slot lock and keeps it, standing in for a
// live runner or for an orphaned Codex holding the inherited descriptor.
async function holdLock(lockPath, job) {
  const code = `import { writeFileSync } from "node:fs";
    import { acquireLock } from ${JSON.stringify(scriptPath)};
    const fd = acquireLock(${JSON.stringify(lockPath)});
    if (fd === null) { process.stdout.write("busy\\n"); process.exit(1); }
    writeFileSync(${JSON.stringify(`${lockPath}.holder.json`)}, JSON.stringify({ job: ${JSON.stringify(job)}, pid: process.pid, pgid: process.pid }));
    process.stdout.write("held\\n");
    setTimeout(() => {}, 30000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.unref();
  const line = await new Promise((done) => child.stdout.once("data", (chunk) => done(String(chunk))));
  child.stdout.destroy();
  assert.equal(line.trim(), "held");
  return child.pid;
}

function killQuietly(pgid) {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------- wiring ----------

test("SKILL.md allows only the runner and documents background use", () => {
  const skill = readFileSync(join(skillDirectory, "SKILL.md"), "utf8");
  assert.match(skill, /^name: codex-agent$/m);
  assert.match(skill, /^allowed-tools: Bash\(\$\{CLAUDE_SKILL_DIR\}\/scripts\/codex-agent\.mjs \*\)$/m);
  assert.match(skill, /run_in_background/);
  assert.match(skill, /\$\{CLAUDE_SKILL_DIR\}\/scripts\/codex-agent\.mjs/);
});

test("schemas follow Codex strict mode at every level", () => {
  const visit = (schema, at) => {
    if (schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"))) {
      assert.equal(schema.additionalProperties, false, `${at} must set additionalProperties false`);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${at} must require every property`);
      for (const [key, child] of Object.entries(schema.properties)) visit(child, `${at}.${key}`);
    }
    if (schema.items) visit(schema.items, `${at}[]`);
    for (const keyword of ["minLength", "maxLength", "minimum", "maximum", "pattern", "format"]) {
      assert.equal(Object.hasOwn(schema, keyword), false, `${at} uses unsupported ${keyword}`);
    }
  };
  for (const file of readdirSync(join(skillDirectory, "schemas"))) {
    visit(JSON.parse(readFileSync(join(skillDirectory, "schemas", file), "utf8")), file);
  }
});

// ---------- pure helpers ----------

test("parseArgs collects repeatable flags and rejects unknown ones", () => {
  const parsed = parseArgs(["run", "--mode", "implement", "--scope", "a", "--scope=b", "--allow-dirty"]);
  assert.deepEqual(parsed.flags.scope, ["a", "b"]);
  assert.equal(parsed.flags["allow-dirty"], true);
  assert.throws(() => parseArgs(["run", "--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["run", "--mode", "a", "--mode", "b"]), /given twice/);
});

test("parsePorcelain keeps both sides of a rename", () => {
  const buffer = Buffer.from(" M src/a.txt\0R  new.txt\0old.txt\0?? dir/u.txt\0", "utf8");
  assert.deepEqual(parsePorcelain(buffer), ["src/a.txt", "new.txt", "old.txt", "dir/u.txt"]);
});

test("normalizeScope confines paths to the repository", () => {
  assert.deepEqual(normalizeScope("/r", ["src/", "/r/lib/x.ts", "src"], { mode: "implement" }), ["lib/x.ts", "src"]);
  assert.throws(() => normalizeScope("/r", ["../x"], { mode: "review" }), /outside the repository/);
  assert.throws(() => normalizeScope("/r", ["."], { mode: "implement" }), /narrower than the repository root/);
  assert.deepEqual(normalizeScope("/r", ["."], { mode: "research" }), ["."]);
  assert.equal(inScope("src/a/b.ts", ["src/a"]), true);
  assert.equal(inScope("src/ab.ts", ["src/a"]), false);
});

test("configuredMcpServers reads only top-level server tables", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-mcp-"));
  try {
    const path = join(root, "config.toml");
    writeFileSync(path, '[mcp_servers]\n[mcp_servers.a-b]\n[mcp_servers.a-b.env]\n[mcp_servers."x.y"]\n[other.mcp_servers.z]\n');
    assert.deepEqual(configuredMcpServers([path, join(root, "missing.toml")]), ["a-b", "x.y"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("diffSnapshots and attribute separate scope, strays, and false claims", () => {
  const pre = { "other.txt": "h1", "src/keep.txt": "h2", "reset.txt": "h5" };
  const now = { "other.txt": "h1", "src/keep.txt": "h2", "src/a.txt": "h3", "stray.txt": "h4" };
  const changed = diffSnapshots(pre, now, (path) => now[path] ?? "head-content");
  assert.deepEqual(changed.map((entry) => entry.path), ["reset.txt", "src/a.txt", "stray.txt"]);
  const reset = changed.find((entry) => entry.path === "reset.txt");
  assert.equal(reset.after, "clean");
  assert.equal(reset.afterHash, "head-content");
  const attribution = attribute({
    changed,
    scope: ["src"],
    claimed: ["src/a.txt", "src/b.txt"],
    evidence: ["/bin/zsh -lc 'echo x > stray.txt'"],
  });
  assert.deepEqual(attribution.changed_in_scope, ["src/a.txt"]);
  assert.deepEqual(
    attribution.out_of_scope.map((entry) => [entry.path, entry.codex_evidence]),
    [
      ["reset.txt", false],
      ["stray.txt", true],
    ],
  );
  assert.deepEqual(attribution.claimed_not_changed, ["src/b.txt"]);
  assert.deepEqual(attribution.changed_not_claimed, []);
});

test("isRegenerable skips caches and build output only", () => {
  for (const path of ["node_modules/", "packages/x/node_modules/a.js", "dist/", ".next-mobile-dev/", "a/__pycache__/", "tsconfig.tsbuildinfo", "x.egg-info/"]) {
    assert.equal(isRegenerable(path), true, path);
  }
  for (const path of [".env.local", "deploy/compose/.env", ".claude/settings.local.json", "docs/superpowers/plans/"]) {
    assert.equal(isRegenerable(path), false, path);
  }
});

test("validateSchema reports type, enum, missing, and extra keys", () => {
  const schema = JSON.parse(readFileSync(join(skillDirectory, "schemas", "review.schema.json"), "utf8"));
  assert.deepEqual(validateSchema(schema, REVIEW_FINAL), []);
  const errors = validateSchema(schema, { verdict: "maybe", summary: 1, findings: [], extra: true });
  assert.ok(errors.some((error) => error.includes("not in enum")));
  assert.ok(errors.some((error) => error.includes("$.summary: expected string")));
  assert.ok(errors.some((error) => error.includes("missing next_steps")));
  assert.ok(errors.some((error) => error.includes("unexpected extra")));
});

// ---------- read-only modes ----------

test(
  "review pins read-only, schema output, disabled MCP servers, and the shared-tree target",
  withContext((context) => {
    scenario(context, [{ final: REVIEW_FINAL, usage: { input_tokens: 10, output_tokens: 2 } }]);
    const result = run(context, ["run", "--mode", "review", "--scope", "src", "--adversarial"], "Focus on races.");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.status, "succeeded");
    assert.equal(result.output.thread_id, "thread-1");
    assert.deepEqual(result.output.result, REVIEW_FINAL);
    assert.equal(result.output.usage.input_tokens, 10);

    const [call] = invocations(context);
    assert.equal(call.args[0], "exec");
    assert.equal(optionValue(call.args, "--sandbox"), "read-only");
    assert.ok(call.args.includes("--json"));
    assert.match(optionValue(call.args, "--output-schema"), /review\.schema\.json$/);
    assert.equal(call.args.at(-1), "-");
    assert.ok(call.args.includes('model_reasoning_effort="medium"'));
    for (const name of ["context7", "exa", "node_repl"]) {
      assert.ok(call.args.includes(`mcp_servers.${name}.enabled=false`), name);
    }
    assert.equal(call.args.some((arg) => arg.includes("node_repl.env")), false);
    assert.match(call.prompt, /adversarial code review/);
    assert.match(call.prompt, /Uncommitted changes in: src/);
    assert.match(call.prompt, /git diff HEAD -- src/);
    assert.match(call.prompt, /Git is read-only for you/);
    assert.match(call.prompt, /"Focus on races\."/);
    assert.equal(/\{\{[A-Z_]+\}\}/.test(call.prompt), false);

    const stored = run(context, ["result", result.output.job]);
    assert.equal(stored.output.job, result.output.job);
    const meta = run(context, ["status", result.output.job]);
    assert.equal(meta.output.status, "succeeded");
    assert.equal(Object.hasOwn(meta.output, "_lastFlush"), false);
  }),
);

test(
  "review refuses to guess a target in the shared tree",
  withContext((context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const result = run(context, ["run", "--mode", "review"], "");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /review needs --scope, --base, or --commit/);
    assert.equal(invocations(context).length, 0);
  }),
);

test(
  "research with --search puts the live-search flag before exec",
  withContext((context) => {
    scenario(context, [{ final: { answer: "x", findings: [], open_questions: [] } }]);
    const result = run(context, ["run", "--mode", "research", "--search"], "What is X?");
    assert.equal(result.status, 0, result.stderr);
    const [call] = invocations(context);
    assert.deepEqual(call.args.slice(0, 2), ["--search", "exec"]);
    assert.match(call.prompt, /live web_search tool/);
  }),
);

test(
  "read-only jobs are capped at two concurrent runs",
  withContext(async (context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const first = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(first.output.job_dir);
    const holders = [];
    try {
      for (const index of [0, 1]) holders.push(await holdLock(join(store, `read-only-${index}.lock`), `review-held-${index}`));
      const result = run(context, ["run", "--mode", "review", "--scope", "src"]);
      assert.equal(result.status, 3);
      assert.match(result.stderr, /2 read-only jobs already running \(review-held-0, review-held-1\)/);
      assert.equal(invocations(context).length, 1);
    } finally {
      holders.forEach(killQuietly);
    }
  }),
);

// ---------- implement mode ----------

test(
  "implement refuses a scope that already holds someone else's changes",
  withContext((context) => {
    scenario(context, [{ final: implementFinal([]) }]);
    writeFileSync(join(context.repo, "src", "a.txt"), "edited by another session\n");
    const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
    assert.equal(result.status, 3);
    assert.match(result.stderr, /src\/a\.txt/);
    assert.equal(invocations(context).length, 0);
    const jobDirectories = existsSync(context.home)
      ? readdirSync(context.home).flatMap((dir) =>
          readdirSync(join(context.home, dir), { withFileTypes: true }).filter((entry) => entry.isDirectory()),
        )
      : [];
    assert.equal(jobDirectories.length, 0);
  }),
);

test(
  "implement attributes in-scope work, flags strays, and restores them",
  withContext((context) => {
    writeFileSync(join(context.repo, "other.txt"), "another session's edit\n");
    scenario(context, [
      {
        writes: [
          { path: "src/a.txt", content: "codex\n" },
          { path: "stray.txt", content: "stray\n" },
          { path: "other.txt", content: "clobbered\n" },
        ],
        events: [
          {
            type: "item.completed",
            item: { id: "c1", type: "command_execution", command: "sh -c 'echo > stray.txt; echo > other.txt'", exit_code: 0 },
          },
        ],
        final: implementFinal(["src/a.txt", "src/b.txt"]),
      },
    ]);
    const result = run(
      context,
      ["run", "--mode", "implement", "--scope", "src", "--verify", "pnpm test -- src/a.test.ts"],
      "Change a.",
    );
    assert.equal(result.status, 5, result.stderr);
    const { output } = result;
    assert.equal(output.status, "needs_attention");
    assert.deepEqual(output.attribution.changed_in_scope, ["src/a.txt"]);
    assert.deepEqual(
      output.attribution.out_of_scope.map((entry) => [entry.path, entry.codex_evidence]),
      [
        ["other.txt", true],
        ["stray.txt", true],
      ],
    );
    assert.deepEqual(output.attribution.claimed_not_changed, ["src/b.txt"]);
    assert.ok(output.next.some((step) => step.includes("git diff -- src/a.txt")));

    const [call] = invocations(context);
    assert.equal(optionValue(call.args, "--sandbox"), "workspace-write");
    assert.match(call.prompt, /- src\n/);
    assert.match(call.prompt, /- pnpm test -- src\/a\.test\.ts/);

    const restored = run(context, ["restore", output.job, "other.txt", "stray.txt"]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readFileSync(join(context.repo, "other.txt"), "utf8"), "another session's edit\n");
    assert.equal(existsSync(join(context.repo, "stray.txt")), false);
    assert.equal(readFileSync(join(context.repo, "src", "a.txt"), "utf8"), "codex\n");

    const refused = run(context, ["restore", output.job, "src/a.txt"]);
    assert.equal(refused.status, 3);
  }),
);

test(
  "only one implement job holds the writer lock",
  withContext(async (context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const probe = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(probe.output.job_dir);
    const holder = await holdLock(join(store, "implement.lock"), "implement-x");
    try {
      const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
      assert.equal(result.status, 3);
      assert.match(result.stderr, /implement-x is already running/);
    } finally {
      killQuietly(holder);
    }
  }),
);

test(
  "a lock left by a dead holder frees itself and the lock file is never deleted",
  withContext((context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const probe = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(probe.output.job_dir);
    writeFileSync(join(store, "implement.lock"), "");
    writeFileSync(join(store, "implement.lock.holder.json"), JSON.stringify({ job: "implement-dead", pid: 999_999, pgid: null }));
    scenario(context, [{ writes: [{ path: "src/a.txt", content: "x\n" }], final: implementFinal(["src/a.txt"]) }]);
    const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(store, "implement.lock")), true);
  }),
);

// ---------- failures, retries, timeouts ----------

test(
  "a transient failure before any write is retried once",
  withContext((context) => {
    scenario(context, [
      { events: [{ type: "error", message: "stream disconnected before completion" }], exitCode: 1 },
      { final: REVIEW_FINAL },
    ]);
    const result = run(context, ["run", "--mode", "review", "--scope", "src"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.attempts, 2);
    assert.equal(invocations(context).length, 2);
  }),
);

test(
  "a non-transient failure is reported, not retried",
  withContext((context) => {
    scenario(context, [{ events: [{ type: "turn.failed", error: { message: "model refused" } }], exitCode: 1 }]);
    const result = run(context, ["run", "--mode", "review", "--scope", "src"]);
    assert.equal(result.status, 1);
    assert.equal(result.output.status, "failed");
    assert.match(result.output.error, /model refused/);
    assert.equal(invocations(context).length, 1);
  }),
);

test(
  "a transient failure after a write is not retried",
  withContext((context) => {
    scenario(context, [
      { writes: [{ path: "src/a.txt", content: "half\n" }], stderr: "429 rate limit", exitCode: 1 },
      { final: implementFinal(["src/a.txt"]) },
    ]);
    const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
    assert.equal(result.status, 1);
    assert.equal(result.output.attempts, 1);
    assert.deepEqual(result.output.attribution.changed_in_scope, ["src/a.txt"]);
  }),
);

test(
  "an answer that violates the schema fails the job",
  withContext((context) => {
    scenario(context, [{ final: { verdict: "approve" } }]);
    const result = run(context, ["run", "--mode", "review", "--scope", "src"]);
    assert.equal(result.status, 1);
    assert.match(result.output.error, /violates the schema/);
  }),
);

test(
  "the idle watchdog kills a silent Codex process group",
  withContext((context) => {
    scenario(context, [{ sleepMs: 30_000, final: REVIEW_FINAL }]);
    const result = run(context, ["run", "--mode", "review", "--scope", "src", "--idle-timeout-ms", "1000"]);
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.output.status, "idle_timeout");
    const [call] = invocations(context);
    assert.throws(() => process.kill(call.pid, 0));
  }),
);

test(
  "the wall-clock timeout stops a run that keeps emitting events",
  withContext((context) => {
    const events = Array.from({ length: 1 }, () => ({ type: "item.completed", item: { id: "m", type: "agent_message", text: "." } }));
    scenario(context, [{ events, sleepMs: 30_000, final: REVIEW_FINAL }]);
    const result = run(context, ["run", "--mode", "review", "--scope", "src", "--timeout-ms", "1500", "--idle-timeout-ms", "60000"]);
    assert.equal(result.status, 4, result.stderr);
    assert.equal(result.output.status, "timed_out");
  }),
);

// ---------- resume and cancel ----------

test(
  "resume continues the recorded thread with exec options before the subcommand",
  withContext((context) => {
    scenario(context, [{ threadId: "thread-abc", final: REVIEW_FINAL }]);
    const first = run(context, ["run", "--mode", "review", "--scope", "src"]);
    assert.equal(first.status, 0, first.stderr);

    let parent = first.output.job;
    for (let depth = 1; depth <= 2; depth += 1) {
      const next = run(context, ["resume", parent], "Dig deeper into a.txt.");
      assert.equal(next.status, 0, next.stderr);
      assert.equal(next.output.parent, parent);
      parent = next.output.job;
    }
    const calls = invocations(context);
    const resumed = calls[1].args;
    const resumeIndex = resumed.indexOf("resume");
    assert.ok(resumeIndex > resumed.indexOf("--sandbox"));
    assert.equal(resumed[resumeIndex + 1], "thread-abc");
    assert.equal(optionValue(resumed, "--sandbox"), "read-only");
    assert.match(calls[1].prompt, /"Dig deeper into a\.txt\."/);

    const third = run(context, ["resume", parent], "Again.");
    assert.equal(third.status, 3);
    assert.match(third.stderr, /ask the user/);
    const forced = run(context, ["resume", parent, "--force"], "Again.");
    assert.equal(forced.status, 0, forced.stderr);
  }),
);

test(
  "resume rejects changing the parent's scope",
  withContext((context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const first = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const result = run(context, ["resume", first.output.job, "--scope", "other.txt"], "x");
    assert.equal(result.status, 2);
  }),
);

test(
  "an implement resume accepts the chain's own earlier edits",
  withContext((context) => {
    scenario(context, [{ writes: [{ path: "src/a.txt", content: "step1\n" }], final: implementFinal(["src/a.txt"]) }]);
    const first = run(context, ["run", "--mode", "implement", "--scope", "src"], "Step one.");
    assert.equal(first.status, 0, first.stderr);

    scenario(context, [{ writes: [{ path: "src/a.txt", content: "step2\n" }], final: implementFinal(["src/a.txt"]) }]);
    const second = run(context, ["resume", first.output.job], "Step two.");
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(second.output.attribution.changed_in_scope, ["src/a.txt"]);

    writeFileSync(join(context.repo, "src", "a.txt"), "someone else\n");
    const third = run(context, ["resume", second.output.job], "Step three.");
    assert.equal(third.status, 3);
    assert.match(third.stderr, /src\/a\.txt/);
  }),
);

test(
  "cancel stops a running job and its Codex process",
  withContext(async (context) => {
    scenario(context, [{ sleepMs: 30_000, final: REVIEW_FINAL }]);
    const child = spawn(process.execPath, [scriptPath, "run", "--mode", "review", "--scope", "src"], {
      cwd: context.repo,
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const exited = new Promise((done) => child.on("close", (code) => done(code)));

    let jobId = null;
    for (let attempt = 0; attempt < 100 && !jobId; attempt += 1) {
      await new Promise((done) => setTimeout(done, 100));
      if (invocations(context).length === 0) continue;
      const listing = run(context, ["status"]).output ?? [];
      jobId = listing.find((row) => row.status === "running")?.job ?? null;
    }
    assert.ok(jobId, "job never reached running");

    const cancelled = run(context, ["cancel", jobId]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(await exited, 130);
    assert.equal(JSON.parse(stdout).status, "cancelled");
    assert.throws(() => process.kill(invocations(context)[0].pid, 0));
  }),
);

test(
  "a job whose runner died is reaped as lost",
  withContext((context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const probe = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(probe.output.job_dir);
    const id = "review-20260101-000000-cccccc";
    mkdirSync(join(store, id));
    writeFileSync(
      join(store, id, "meta.json"),
      JSON.stringify({ id, mode: "review", status: "running", runnerPid: 999_999, codexPid: null, startedAt: id }),
    );
    const listing = run(context, ["status"]).output;
    assert.equal(listing.find((row) => row.job === id).status, "lost");
  }),
);

// ---------- regression tests from the adversarial review ----------

test("concurrent acquirers get exactly one lock, never a torn record", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-lock-"));
  try {
    const lockPath = join(root, "implement.lock");
    const racer = `import { acquireLock } from ${JSON.stringify(scriptPath)};
      const fd = acquireLock(${JSON.stringify(lockPath)});
      process.stdout.write(fd === null ? "lost" : "won");
      setTimeout(() => {}, 1500);`;
    const racers = Array.from({ length: 8 }, () =>
      new Promise((done) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", racer], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.on("close", () => done(out));
      }),
    );
    const results = await Promise.all(racers);
    assert.equal(results.filter((result) => result === "won").length, 1, results.join(","));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a slot stays held while an inheriting process lives and frees itself after", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-agent-lock-"));
  try {
    const lockPath = join(root, "implement.lock");
    const fd = acquireLock(lockPath);
    assert.notEqual(fd, null);
    const inheritor = spawn("sleep", ["1"], { stdio: ["ignore", "ignore", "ignore", fd] });
    closeSync(fd);
    assert.equal(acquireLock(lockPath), null);
    await new Promise((done) => inheritor.on("close", done));
    const again = acquireLock(lockPath);
    assert.notEqual(again, null);
    closeSync(again);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function orphanMeta(store, id, fields) {
  mkdirSync(join(store, id));
  writeFileSync(
    join(store, id, "meta.json"),
    JSON.stringify({ id, mode: "implement", status: "running", runnerPid: 999_999, startedAt: new Date().toISOString(), ...fields }),
  );
}

test(
  "an orphaned Codex still holding its job's slot is killed before the job is marked lost",
  withContext(async (context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const probe = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(probe.output.job_dir);
    const id = "implement-20260101-000000-dddddd";
    const lock = join(store, "implement.lock");
    const pgid = await holdLock(lock, id);
    try {
      orphanMeta(store, id, { codexPid: pgid, lock });
      const listing = run(context, ["status"]).output;
      assert.equal(listing.find((row) => row.job === id).status, "lost");
      assert.equal(groupAlive(pgid), false);
      const fd = acquireLock(lock);
      assert.notEqual(fd, null);
      closeSync(fd);
    } finally {
      killQuietly(pgid);
    }
  }),
);

test(
  "descendants left by an exited Codex are killed",
  withContext(async (context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const probe = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(probe.output.job_dir);
    const pgid = await spawnLeaderlessGroup();
    try {
      assert.equal(groupAlive(pgid), true);
      orphanMeta(store, "implement-20260101-000000-eeeeee", { codexPid: pgid, lock: join(store, "implement.lock") });
      run(context, ["status"]);
      assert.equal(groupAlive(pgid), false);
    } finally {
      killQuietly(pgid);
    }
  }),
);

test(
  "a live group leader that holds no slot is never signalled (its id may be reused)",
  withContext((context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const probe = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(probe.output.job_dir);
    const pgid = spawnGroup();
    try {
      const id = "implement-20260101-000000-ffffff";
      orphanMeta(store, id, { codexPid: pgid, lock: join(store, "implement.lock") });
      const listing = run(context, ["status"]).output;
      assert.equal(listing.find((row) => row.job === id).status, "lost");
      assert.equal(groupAlive(pgid), true);
    } finally {
      killQuietly(pgid);
    }
  }),
);

test(
  "ignored files outside the caches are protected like tracked work",
  withContext((context) => {
    writeFileSync(join(context.repo, ".gitignore"), ".env.local\nnode_modules/\n");
    git(context.repo, "add", ".gitignore");
    git(context.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore");
    writeFileSync(join(context.repo, ".env.local"), "SECRET=mine\n");
    scenario(context, [
      {
        writes: [
          { path: "src/a.txt", content: "codex\n" },
          { path: ".env.local", content: "SECRET=clobbered\n" },
          { path: "node_modules/pkg/index.js", content: "cache\n" },
        ],
        final: implementFinal(["src/a.txt"]),
      },
    ]);
    const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
    assert.equal(result.status, 5, result.stderr);
    assert.deepEqual(
      result.output.attribution.out_of_scope.map((entry) => [entry.path, entry.ignored]),
      [[".env.local", true]],
    );
    const restored = run(context, ["restore", result.output.job, ".env.local"]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readFileSync(join(context.repo, ".env.local"), "utf8"), "SECRET=mine\n");
  }),
);

test(
  "restore refuses a file edited again after Codex reset it to HEAD",
  withContext((context) => {
    writeFileSync(join(context.repo, "other.txt"), "another session's edit\n");
    scenario(context, [
      {
        writes: [
          { path: "src/a.txt", content: "codex\n" },
          { path: "other.txt", content: "other\n" },
        ],
        final: implementFinal(["src/a.txt"]),
      },
    ]);
    const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
    const entry = result.output.attribution.out_of_scope.find((item) => item.path === "other.txt");
    assert.equal(entry.after, "clean");

    writeFileSync(join(context.repo, "other.txt"), "newer edit by that session\n");
    const refused = run(context, ["restore", result.output.job, "other.txt"]);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /changed again/);
    assert.equal(readFileSync(join(context.repo, "other.txt"), "utf8"), "newer edit by that session\n");
  }),
);

test(
  "a transient failure after Codex ran a command is not retried",
  withContext((context) => {
    scenario(context, [
      {
        events: [
          { type: "item.completed", item: { id: "c1", type: "command_execution", command: "touch /tmp/x", exit_code: 0 } },
          { type: "error", message: "stream disconnected before completion" },
        ],
        exitCode: 1,
      },
      { final: REVIEW_FINAL },
    ]);
    const result = run(context, ["run", "--mode", "review", "--scope", "src"]);
    assert.equal(result.status, 1);
    assert.equal(invocations(context).length, 1);
  }),
);

test(
  "finished jobs older than two weeks are pruned, recent and running ones kept",
  withContext((context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const probe = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(probe.output.job_dir);
    const old = new Date(Date.now() - 15 * 24 * 3_600_000).toISOString();
    const jobs = {
      "review-20260101-000000-111111": { status: "succeeded", finishedAt: old },
      "review-20260101-000000-222222": { status: "running", runnerPid: process.pid, finishedAt: null },
    };
    for (const [id, fields] of Object.entries(jobs)) {
      mkdirSync(join(store, id));
      writeFileSync(join(store, id, "meta.json"), JSON.stringify({ id, mode: "review", startedAt: old, ...fields }));
    }
    run(context, ["status"]);
    assert.equal(existsSync(join(store, "review-20260101-000000-111111")), false);
    assert.equal(existsSync(join(store, "review-20260101-000000-222222")), true);
    assert.equal(existsSync(probe.output.job_dir), true);
  }),
);

test(
  "a new holder kills what the previous holder left behind before it starts",
  withContext(async (context) => {
    scenario(context, [{ final: REVIEW_FINAL }]);
    const probe = run(context, ["run", "--mode", "review", "--scope", "src"]);
    const store = dirname(probe.output.job_dir);
    const pgid = await spawnLeaderlessGroup();
    try {
      // The orphan sweep cannot see this one: its job already reads as finished.
      const previous = "implement-20260101-000000-999999";
      mkdirSync(join(store, previous));
      writeFileSync(
        join(store, previous, "meta.json"),
        JSON.stringify({ id: previous, mode: "implement", status: "succeeded", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }),
      );
      writeFileSync(join(store, "implement.lock.holder.json"), JSON.stringify({ job: previous, pid: 999_999, pgid }));
      scenario(context, [{ writes: [{ path: "src/a.txt", content: "x\n" }], final: implementFinal(["src/a.txt"]) }]);
      const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(groupAlive(pgid), false);
    } finally {
      killQuietly(pgid);
    }
  }),
);

test(
  "restore waits for the writer slot",
  withContext(async (context) => {
    scenario(context, [{ writes: [{ path: "src/a.txt", content: "x\n" }, { path: "stray.txt", content: "s\n" }], final: implementFinal(["src/a.txt"]) }]);
    const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
    assert.equal(result.status, 5, result.stderr);
    const holder = await holdLock(join(dirname(result.output.job_dir), "implement.lock"), "implement-live");
    try {
      const refused = run(context, ["restore", result.output.job, "stray.txt"]);
      assert.equal(refused.status, 3);
      assert.match(refused.stderr, /implement-live is running/);
      assert.equal(existsSync(join(context.repo, "stray.txt")), true);
    } finally {
      killQuietly(holder);
    }
  }),
);

test(
  "restore replaces a symlink Codex planted instead of writing through it",
  withContext((context) => {
    writeFileSync(join(context.repo, "other.txt"), "another session's edit\n");
    scenario(context, [
      {
        writes: [{ path: "src/a.txt", content: "codex\n" }],
        symlinks: [{ path: "other.txt", target: "src/a.txt" }],
        final: implementFinal(["src/a.txt"]),
      },
    ]);
    const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
    assert.equal(result.status, 5, result.stderr);
    const restored = run(context, ["restore", result.output.job, "other.txt"]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(lstatSync(join(context.repo, "other.txt")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(context.repo, "other.txt"), "utf8"), "another session's edit\n");
    assert.equal(readFileSync(join(context.repo, "src", "a.txt"), "utf8"), "codex\n");
  }),
);

test(
  "a malformed answer after writes still yields attribution and a stored result",
  withContext((context) => {
    scenario(context, [
      {
        writes: [{ path: "src/a.txt", content: "codex\n" }, { path: "stray.txt", content: "s\n" }],
        final: { status: "done", summary: "x", files_changed: "oops", verification: [], blockers: [], follow_ups: [] },
      },
    ]);
    const result = run(context, ["run", "--mode", "implement", "--scope", "src"], "Do it.");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.output.error, /violates the schema/);
    assert.deepEqual(result.output.attribution.changed_in_scope, ["src/a.txt"]);
    assert.deepEqual(result.output.attribution.out_of_scope.map((entry) => entry.path), ["stray.txt"]);
    assert.equal(existsSync(join(result.output.job_dir, "result.json")), true);
    const restored = run(context, ["restore", result.output.job, "stray.txt"]);
    assert.equal(restored.status, 0, restored.stderr);
  }),
);
