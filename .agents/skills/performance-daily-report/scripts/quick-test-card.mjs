#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CARD_ELEMENTS = 200;

export class QuickTestError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "QuickTestError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  return `Usage: quick-test-card.mjs --card <path> [options]

Validate a Feishu Card 2.0 JSON file and send it to the current lark-cli user
with the currently configured, verified bot identity. Sending always uses
"--as bot", including when --user-id overrides the recipient.

Options:
  --card <path>             Card 2.0 JSON file to preview
  --user-id <ou_xxx>       Override the current authenticated user's open_id
  --idempotency-key <key>  Custom key, at most 50 characters
  --timeout-ms <ms>        Timeout per lark-cli call (default: 30000)
  --dry-run                Validate and print the result without sending
  --pretty                 Pretty-print the JSON envelope
  --help                   Show this help
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new QuickTestError("INVALID_ARGUMENT", `${flag} requires a value.`);
  }
  return value;
}

function parseInteger(value, flag, { min, max }) {
  if (!/^\d+$/.test(String(value))) {
    throw new QuickTestError("INVALID_ARGUMENT", `${flag} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new QuickTestError("INVALID_ARGUMENT", `${flag} is outside the supported range.`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    dryRun: false,
    pretty: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--card":
        options.cardPath = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--user-id":
        options.userId = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--idempotency-key":
        options.idempotencyKey = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parseInteger(requireValue(argv, index, arg), arg, {
          min: 1_000,
          max: 120_000,
        });
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--pretty":
        options.pretty = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new QuickTestError("INVALID_ARGUMENT", `Unknown option: ${arg}`);
    }
  }

  if (!options.help && !options.cardPath) {
    throw new QuickTestError("INVALID_ARGUMENT", "--card is required.");
  }
  if (options.userId && !/^ou_[A-Za-z0-9]+$/.test(options.userId)) {
    throw new QuickTestError("INVALID_ARGUMENT", "--user-id must be a Feishu open_id such as ou_xxx.");
  }
  if (options.idempotencyKey && options.idempotencyKey.length > 50) {
    throw new QuickTestError("INVALID_ARGUMENT", "--idempotency-key must not exceed 50 characters.");
  }

  return options;
}

function countTaggedElements(value) {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countTaggedElements(item), 0);
  }
  if (!value || typeof value !== "object") return 0;
  const current = typeof value.tag === "string" ? 1 : 0;
  return current + Object.values(value).reduce((total, item) => total + countTaggedElements(item), 0);
}

export function validateCard(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new QuickTestError("INVALID_CARD", "Card JSON must be an object.");
  }
  if (card.schema !== "2.0") {
    throw new QuickTestError("INVALID_CARD", 'Card JSON must declare "schema": "2.0".');
  }
  const title = card.header?.title?.content;
  if (typeof title !== "string" || !title.trim()) {
    throw new QuickTestError("INVALID_CARD", "Card header.title.content must be a non-empty string.");
  }
  if (!Array.isArray(card.body?.elements) || card.body.elements.length === 0) {
    throw new QuickTestError("INVALID_CARD", "Card body.elements must be a non-empty array.");
  }
  const elementCount = countTaggedElements(card.body.elements);
  if (elementCount > MAX_CARD_ELEMENTS) {
    throw new QuickTestError(
      "INVALID_CARD",
      `Card has ${elementCount} tagged body elements; Feishu Card 2.0 supports at most ${MAX_CARD_ELEMENTS}.`,
    );
  }
  return { title: title.trim(), elementCount };
}

export function parseJsonOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) {
    throw new QuickTestError("INVALID_CLI_OUTPUT", "lark-cli returned empty output.");
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to the stable error below.
      }
    }
  }
  throw new QuickTestError("INVALID_CLI_OUTPUT", "lark-cli output was not valid JSON.");
}

function commandError(code, result, fallbackMessage) {
  let payload;
  try {
    payload = parseJsonOutput(result.stderr || result.stdout);
  } catch {
    payload = null;
  }
  const source = payload?.error ?? payload;
  const details = {
    exit_code: result.exitCode,
    ...(typeof source?.code === "number" ? { api_code: source.code } : {}),
    ...(Array.isArray(source?.missing_scopes) ? { missing_scopes: source.missing_scopes } : {}),
    ...(typeof source?.console_url === "string" ? { console_url: source.console_url } : {}),
  };
  return new QuickTestError(code, source?.message ?? fallbackMessage, details);
}

export function resolveSelfUser(authStatus) {
  const userId =
    authStatus?.userOpenId ??
    authStatus?.user_open_id ??
    authStatus?.identities?.user?.openId ??
    authStatus?.identities?.user?.open_id;
  if (typeof userId !== "string" || !/^ou_[A-Za-z0-9]+$/.test(userId)) {
    throw new QuickTestError(
      "SELF_USER_UNAVAILABLE",
      "Current lark-cli user open_id is unavailable. Sign in as a user or pass --user-id ou_xxx.",
    );
  }

  return {
    userId,
    userName: authStatus?.userName ?? authStatus?.identities?.user?.userName ?? null,
  };
}

export function resolveBotIdentity(authStatus) {
  const bot = authStatus?.identities?.bot;
  if (!bot || bot.available === false || bot.verified === false || bot.status !== "ready") {
    throw new QuickTestError("BOT_NOT_READY", bot?.message || "The configured bot identity is not ready.");
  }

  return {
    botName: bot?.appName ?? null,
    botOpenId: bot?.openId ?? bot?.open_id ?? null,
    botAppId: bot?.appId ?? bot?.app_id ?? null,
  };
}

export function buildIdempotencyKey(cardJson, now = new Date()) {
  const timestamp = now.getTime().toString(36);
  const digest = createHash("sha256").update(cardJson).digest("hex").slice(0, 8);
  return `perf-preview-${timestamp}-${digest}`;
}

async function runLarkCli(args, { timeoutMs }) {
  const env = {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
  try {
    const result = await execFileAsync("lark-cli", args, {
      encoding: "utf8",
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? "",
    };
  }
}

export async function quickTestCard(options, dependencies = {}) {
  const runner = dependencies.runner ?? runLarkCli;
  const now = dependencies.now ?? new Date();
  const absoluteCardPath = path.resolve(options.cardPath);

  let card;
  try {
    card = JSON.parse(await readFile(absoluteCardPath, "utf8"));
  } catch (error) {
    const code = error instanceof SyntaxError ? "INVALID_CARD_JSON" : "CARD_READ_FAILED";
    throw new QuickTestError(code, `Unable to read card JSON: ${error.message}`);
  }
  const cardInfo = validateCard(card);
  const cardJson = JSON.stringify(card);

  const authResult = await runner(["auth", "status", "--verify"], { timeoutMs: options.timeoutMs });
  if (authResult.exitCode !== 0) {
    throw commandError("AUTH_STATUS_FAILED", authResult, "Unable to read lark-cli authentication status.");
  }
  const authStatus = parseJsonOutput(authResult.stdout);
  const bot = resolveBotIdentity(authStatus);
  const recipient = options.userId
    ? { userId: options.userId, userName: null }
    : resolveSelfUser(authStatus);

  const idempotencyKey = options.idempotencyKey ?? buildIdempotencyKey(cardJson, now);
  const sendArgs = [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--user-id",
    recipient.userId,
    "--msg-type",
    "interactive",
    "--content",
    cardJson,
    "--idempotency-key",
    idempotencyKey,
  ];

  const dryRunResult = await runner([...sendArgs, "--dry-run"], { timeoutMs: options.timeoutMs });
  if (dryRunResult.exitCode !== 0) {
    throw commandError("LARK_DRY_RUN_FAILED", dryRunResult, "lark-cli rejected the card request.");
  }

  const baseData = {
    card_path: absoluteCardPath,
    card_title: cardInfo.title,
    element_count: cardInfo.elementCount,
    recipient_user_id: recipient.userId,
    recipient_user_name: recipient.userName,
    bot_name: bot.botName,
    bot_open_id: bot.botOpenId,
    bot_app_id: bot.botAppId,
    bot_identity_source: "lark-cli auth status --verify",
    sending_identity: "bot",
    idempotency_key: idempotencyKey,
  };
  if (options.dryRun) {
    return { ...baseData, dry_run: true, message_id: null, chat_id: null };
  }

  const sendResult = await runner(sendArgs, { timeoutMs: options.timeoutMs });
  if (sendResult.exitCode !== 0) {
    throw commandError("LARK_SEND_FAILED", sendResult, "lark-cli failed to send the card.");
  }
  const sendEnvelope = parseJsonOutput(sendResult.stdout);
  if (sendEnvelope.ok !== true) {
    throw commandError(
      "LARK_SEND_FAILED",
      { ...sendResult, stderr: JSON.stringify(sendEnvelope) },
      "lark-cli did not report a successful send.",
    );
  }
  if (sendEnvelope.identity !== "bot") {
    throw new QuickTestError(
      "LARK_SEND_WRONG_IDENTITY",
      "lark-cli reported a successful send, but the response identity was not bot.",
    );
  }
  const sent = sendEnvelope.data ?? {};
  const messageId = sent.message_id ?? sent.messageId;
  if (typeof messageId !== "string" || !messageId.startsWith("om_")) {
    throw new QuickTestError("LARK_SEND_INVALID_RESPONSE", "Send succeeded but returned no message_id.");
  }

  return {
    ...baseData,
    dry_run: false,
    message_id: messageId,
    chat_id: sent.chat_id ?? sent.chatId ?? null,
  };
}

function errorEnvelope(error) {
  return {
    status: "error",
    data: null,
    error: {
      code: error.code ?? "UNEXPECTED_ERROR",
      message: error.message ?? String(error),
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const data = await quickTestCard(options);
    process.stdout.write(`${JSON.stringify({ status: "success", data, error: null }, null, options.pretty ? 2 : 0)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorEnvelope(error), null, options?.pretty ? 2 : 0)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
