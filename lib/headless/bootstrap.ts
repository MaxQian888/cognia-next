/**
 * Headless runtime bootstrap (ADR-0059 W2 / T-A1).
 *
 * Starts every registered runtime applicable to the host, with per-runtime
 * failure isolation (one broken runtime must not take the brain down — it is
 * reported in `failed` and the rest keep starting) and reverse-order teardown
 * (later runtimes may depend on earlier ones).
 */
import { listHeadlessRuntimes } from "./registry"
import type { HeadlessRuntimeContext, HeadlessTeardown } from "./types"

export interface BootstrapResult {
  /** Names of runtimes that started successfully, in start order. */
  started: string[]
  /** Runtimes whose `start` threw/rejected, with the error. */
  failed: Array<{ name: string; error: unknown }>
  /** Stop everything that started, in reverse start order. Idempotent. */
  stop(): Promise<void>
}

export async function bootstrapHeadlessRuntimes(
  ctx: HeadlessRuntimeContext
): Promise<BootstrapResult> {
  const started: string[] = []
  const failed: Array<{ name: string; error: unknown }> = []
  const teardowns: Array<{ name: string; teardown: HeadlessTeardown }> = []

  for (const runtime of listHeadlessRuntimes()) {
    if (!runtime.hosts.includes(ctx.host)) continue
    try {
      const teardown = await runtime.start(ctx)
      started.push(runtime.name)
      if (typeof teardown === "function") {
        teardowns.push({ name: runtime.name, teardown })
      }
      ctx.log("info", `headless runtime started: ${runtime.name}`)
    } catch (error) {
      failed.push({ name: runtime.name, error })
      ctx.log(
        "error",
        `headless runtime failed to start: ${runtime.name}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  let stopped = false
  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    for (const { name, teardown } of [...teardowns].reverse()) {
      try {
        await teardown()
        ctx.log("info", `headless runtime stopped: ${name}`)
      } catch (error) {
        ctx.log(
          "warn",
          `headless runtime teardown failed: ${name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  }

  return { started, failed, stop }
}
