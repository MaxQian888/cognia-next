import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildIdempotencyKey,
  parseArgs,
  quickTestCard,
  QuickTestError,
  resolveBotIdentity,
  resolveSelfUser,
  validateCard,
} from "./quick-test-card.mjs";

const CARD = {
  schema: "2.0",
  header: { title: { tag: "plain_text", content: "Performance preview" } },
  body: {
    elements: [
      {
        tag: "column_set",
        columns: [
          {
            tag: "column",
            elements: [{ tag: "markdown", content: "**123 ms**" }],
          },
        ],
      },
    ],
  },
};

test("requires a card and validates optional arguments", () => {
  assert.throws(
    () => parseArgs([]),
    (error) => error instanceof QuickTestError && error.code === "INVALID_ARGUMENT",
  );
  assert.deepEqual(parseArgs(["--card", "card.json", "--dry-run"]), {
    cardPath: "card.json",
    dryRun: true,
    pretty: false,
    timeoutMs: 30_000,
    help: false,
  });
});

test("validates the Card 2.0 root and counts body elements", () => {
  assert.deepEqual(validateCard(CARD), { title: "Performance preview", elementCount: 3 });
  assert.throws(
    () => validateCard({ ...CARD, schema: "1.0" }),
    (error) => error instanceof QuickTestError && error.code === "INVALID_CARD",
  );
});

test("resolves the current user from auth status", () => {
  assert.deepEqual(
    resolveSelfUser({
      userOpenId: "ou_user123",
      userName: "Preview User",
    }),
    { userId: "ou_user123", userName: "Preview User" },
  );
});

test("requires and resolves the verified lark-cli bot identity", () => {
  assert.deepEqual(
    resolveBotIdentity({
      identities: {
        bot: {
          status: "ready",
          available: true,
          verified: true,
          appName: "Preview Bot",
          appId: "cli_preview123",
          openId: "ou_bot123",
        },
      },
    }),
    { botName: "Preview Bot", botAppId: "cli_preview123", botOpenId: "ou_bot123" },
  );
  assert.throws(
    () => resolveBotIdentity({ identities: {} }),
    (error) => error instanceof QuickTestError && error.code === "BOT_NOT_READY",
  );
});

test("builds a short content-aware idempotency key", () => {
  const key = buildIdempotencyKey(JSON.stringify(CARD), new Date("2026-07-31T00:00:00.000Z"));
  assert.match(key, /^perf-preview-[a-z0-9]+-[a-f0-9]{8}$/);
  assert.ok(key.length <= 50);
});

test("runs auth lookup and lark dry-run before sending to self", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perf-card-test-"));
  const cardPath = path.join(tempDir, "card.json");
  await writeFile(cardPath, JSON.stringify(CARD));
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === "auth") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          userOpenId: "ou_user123",
          userName: "Preview User",
          identities: {
            bot: {
              status: "ready",
              available: true,
              verified: true,
              appName: "Preview Bot",
              appId: "cli_preview123",
              openId: "ou_bot123",
            },
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("--dry-run")) {
      return { exitCode: 0, stdout: "=== Dry Run ===\n{}", stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        identity: "bot",
        data: { message_id: "om_preview123", chat_id: "oc_preview123" },
      }),
      stderr: "",
    };
  };

  try {
    const result = await quickTestCard(
      { cardPath, dryRun: false, timeoutMs: 30_000 },
      { runner, now: new Date("2026-07-31T00:00:00.000Z") },
    );
    assert.equal(result.message_id, "om_preview123");
    assert.equal(result.recipient_user_id, "ou_user123");
    assert.equal(result.sending_identity, "bot");
    assert.equal(result.bot_name, "Preview Bot");
    assert.equal(result.bot_open_id, "ou_bot123");
    assert.equal(result.bot_app_id, "cli_preview123");
    assert.equal(result.bot_identity_source, "lark-cli auth status --verify");
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ["auth", "status", "--verify"]);
    assert.ok(calls[1].includes("--dry-run"));
    assert.ok(!calls[2].includes("--dry-run"));
    assert.equal(calls[2][calls[2].indexOf("--user-id") + 1], "ou_user123");
    assert.equal(calls[2][calls[2].indexOf("--as") + 1], "bot");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("dry-run mode never executes the write call", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perf-card-test-"));
  const cardPath = path.join(tempDir, "card.json");
  await writeFile(cardPath, JSON.stringify(CARD));
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === "auth") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          userOpenId: "ou_user123",
          identities: { bot: { status: "ready", available: true, verified: true } },
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "=== Dry Run ===\n{}", stderr: "" };
  };

  try {
    const result = await quickTestCard(
      { cardPath, dryRun: true, timeoutMs: 30_000 },
      { runner, now: new Date("2026-07-31T00:00:00.000Z") },
    );
    assert.equal(result.dry_run, true);
    assert.equal(result.message_id, null);
    assert.equal(calls.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("verifies the bot even when the recipient is overridden", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perf-card-test-"));
  const cardPath = path.join(tempDir, "card.json");
  await writeFile(cardPath, JSON.stringify(CARD));
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (args[0] === "auth") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          identities: {
            bot: {
              status: "ready",
              available: true,
              verified: true,
              appName: "Delivery Bot",
              openId: "ou_bot456",
            },
          },
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "=== Dry Run ===\n{}", stderr: "" };
  };

  try {
    const result = await quickTestCard(
      { cardPath, userId: "ou_target456", dryRun: true, timeoutMs: 30_000 },
      { runner, now: new Date("2026-07-31T00:00:00.000Z") },
    );
    assert.equal(result.recipient_user_id, "ou_target456");
    assert.equal(result.bot_name, "Delivery Bot");
    assert.deepEqual(calls[0], ["auth", "status", "--verify"]);
    assert.equal(calls[1][calls[1].indexOf("--as") + 1], "bot");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects a successful send envelope with a non-bot identity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "perf-card-test-"));
  const cardPath = path.join(tempDir, "card.json");
  await writeFile(cardPath, JSON.stringify(CARD));
  const runner = async (args) => {
    if (args[0] === "auth") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          userOpenId: "ou_user123",
          identities: { bot: { status: "ready", available: true, verified: true } },
        }),
        stderr: "",
      };
    }
    if (args.includes("--dry-run")) {
      return { exitCode: 0, stdout: "=== Dry Run ===\n{}", stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        identity: "user",
        data: { message_id: "om_preview123", chat_id: "oc_preview123" },
      }),
      stderr: "",
    };
  };

  try {
    await assert.rejects(
      quickTestCard({ cardPath, dryRun: false, timeoutMs: 30_000 }, { runner }),
      (error) => error instanceof QuickTestError && error.code === "LARK_SEND_WRONG_IDENTITY",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
