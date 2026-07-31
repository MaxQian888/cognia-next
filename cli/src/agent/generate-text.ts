/**
 * One locked-down, text-only headless turn — the shared generation primitive
 * behind `/commit` and `/pr` (a commit message / PR summary). Mirrors the `/init`
 * rewrite turn: strip every tool and bypass approvals so the model can only
 * return text (it can't edit files or trigger a mid-turn prompt).
 */
import {
  resolveSendOptions as defaultResolveSendOptions,
  type BuildOptionsContext,
} from "@/lib/claude/build-options"
import type { SendOptions } from "@cognia/agent-config-types"

import { runHeadlessTurn } from "./run"
import { createPermissionGate } from "./permission-gate"
import type { ResolvedConfig } from "../config/schema"

/** Strip tools + bypass approvals for a text-only turn. Exported for testing. */
export async function lockdownTextOptions(
  ctx: BuildOptionsContext,
  resolve: (ctx: BuildOptionsContext) => Promise<SendOptions> = defaultResolveSendOptions
): Promise<SendOptions> {
  const opts = await resolve(ctx)
  return { ...opts, allowedTools: [], permissionMode: "bypassPermissions" }
}

export interface GenerateTextInput {
  prompt: string
  config: ResolvedConfig
  cwd: string
  home?: string
  timeoutMs?: number
}

/** Run the locked-down turn and return its text. `run` is injectable for tests. */
export async function generateText(
  input: GenerateTextInput,
  run: typeof runHeadlessTurn = runHeadlessTurn
): Promise<string> {
  const result = await run({
    config: { ...input.config, cwd: input.cwd },
    prompt: input.prompt,
    gate: createPermissionGate({ yes: false }),
    resolveOptions: (ctx: BuildOptionsContext) => lockdownTextOptions(ctx),
    timeoutMs: input.timeoutMs ?? 60_000,
    ...(input.home ? { home: input.home } : {}),
  })
  return result.text
}
