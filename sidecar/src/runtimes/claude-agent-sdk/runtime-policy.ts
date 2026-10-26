import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { Emit, RuntimeQuery } from "./runtime-types.ts"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import { randomUUID } from "node:crypto"
import { awaitApproval } from "../../policy/permission/approval.ts"
import { readPermissionProfile } from "../../policy/permission/permission-classes.ts"
import {
  CLAUDE_CODE_RETRY_MIN_MS,
  CLAUDE_CODE_RETRY_MAX_MS,
} from "@cognia/agent-config-types/claude-agent-sdk-options"

// These policies govern process admission and invocation lifetime, rather than
// the SDK option overlay: neither consent nor a deadline is an SDK setting.

export function unattendedRetryPolicy(sendOptions: SendOptions | undefined) {
  const retry = sendOptions?.claudeAgentSdk?.unattendedRetry
  if (retry === undefined) return undefined
  if (sendOptions?.ledger?.mode === "envelope")
    throw new Error(
      "unattended retry is unavailable with the call ledger: hidden retries bypass reservations"
    )
  for (const key of ["maxWaitMs", "usageLimitRecheckMs"] as const) {
    const value = retry?.[key]
    if (key === "usageLimitRecheckMs" && value === undefined) continue
    if (
      !Number.isSafeInteger(value) ||
      value! < CLAUDE_CODE_RETRY_MIN_MS ||
      value! > CLAUDE_CODE_RETRY_MAX_MS
    )
      throw new Error(
        `unattendedRetry.${key} must be an integer from ${CLAUDE_CODE_RETRY_MIN_MS} to ${CLAUDE_CODE_RETRY_MAX_MS}`
      )
  }
  return { maxWaitMs: retry.maxWaitMs, usageLimitRecheckMs: retry.usageLimitRecheckMs }
}

export function nestedNamespaceRequested(sendOptions: SendOptions, platform = process.platform) {
  const sandbox = sendOptions.claudeAgentSdk?.sandbox
  if (sandbox?.allowNestedUserNamespaces !== true) return false
  if (readPermissionProfile(sendOptions.permissionProfile)?.hostConfig === "deny")
    throw new Error("nested user namespace hostConfig permission is denied by the run profile")
  if (platform !== "linux")
    throw new Error("nested user namespaces require a Linux or WSL2 runtime")
  if (
    sandbox.enabled !== true ||
    sandbox.failIfUnavailable === false ||
    sandbox.allowUnsandboxedCommands === true
  )
    throw new Error("nested user namespaces require an enabled, fail-closed sandbox")
  return true
}

export async function requestNestedNamespaceConsent({
  pendingApprovals,
  sessionId,
  emit,
  signal,
  ttlMs,
  remoteExecutionContext,
}: {
  pendingApprovals: Map<string, PendingApproval>
  sessionId: string
  emit: Emit
  signal: AbortSignal
  ttlMs?: number
  remoteExecutionContext?: SendOptions["remoteExecutionContext"]
}) {
  const requestId = randomUUID()
  const input = Object.freeze({
    allowNestedUserNamespaces: true,
    warning:
      "Nested user namespaces allow sandboxed code to escape file protections and execute outside the sandbox. Authorize only this invocation.",
  })
  const answer = awaitApproval({
    pendingApprovals,
    requestId,
    signal,
    ttlMs,
    entry: { input, requiresExplicitConsent: true, suppressAlwaysAllowRule: true },
    onAbort: () =>
      emit({ type: "permission_interrupted", sessionId, requestId, reason: "interrupted" }),
    onTimeout: () =>
      emit({ type: "permission_interrupted", sessionId, requestId, reason: "approval timed out" }),
  })
  if (!signal.aborted)
    emit({
      type: "permission_request",
      sessionId,
      requestId,
      toolName: "Runtime:Sandbox:NestedUserNamespaces",
      input,
      requiresPerCallApproval: true,
      suppressAlwaysAllowRule: true,
      defaultToNo: true,
      permissionClass: "hostConfig",
      ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
    })
  if ((await answer).behavior !== "allow" || signal.aborted)
    throw new Error("nested user namespace authorization was denied, cancelled, or expired")
}

/** Return synchronously so the host can register approval waiters before start. */
export function createProtectedClaudeQuery({
  create,
  beforeStart,
  maxWaitMs,
  onAbort,
}: {
  create(controller: AbortController): RuntimeQuery | Promise<RuntimeQuery>
  beforeStart?(signal: AbortSignal): Promise<void>
  maxWaitMs?: number
  onAbort?(reason: string): void
}) {
  const controller = new AbortController()
  let raw: RuntimeQuery | undefined
  let ready: Promise<RuntimeQuery> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let closedQuery: RuntimeQuery | undefined
  const closeRaw = (source = raw) => {
    if (!source || source === closedQuery) return
    closedQuery = source
    try {
      source.close?.()
    } catch {
      /* a broken transport cannot block local teardown */
    }
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  // A close can precede iterator consumption; keep its rejection observed.
  void aborted.catch(() => {})
  const stop = (reason: string) => {
    if (controller.signal.aborted || finished) return
    const error = new Error(reason)
    controller.abort(error)
    if (timer) clearTimeout(timer)
    timer = undefined
    try {
      onAbort?.(reason)
    } catch {
      /* renderer cleanup cannot block local cancellation */
    }
    closeRaw()
    rejectAbort(error)
  }
  const start = () =>
    (ready ??= Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw controller.signal.reason
      await beforeStart?.(controller.signal)
      if (controller.signal.aborted) throw controller.signal.reason
      if (maxWaitMs !== undefined) {
        timer = setTimeout(
          () => stop(`unattended retry total invocation deadline exceeded (${maxWaitMs} ms)`),
          maxWaitMs
        )
        timer.unref?.()
      }
      const created = await create(controller)
      raw = created
      if (controller.signal.aborted) {
        closeRaw(created)
        throw controller.signal.reason
      }
      return created
    }))
  const target: RuntimeQuery = {
    interrupt() {
      stop("Claude invocation cancelled")
      // Local abort and close happen before any control RPC, whose promise may
      // never settle while Claude Code waits for a subscription usage reset.
      void Promise.resolve()
        .then(() => raw?.interrupt())
        .catch(() => {})
      return Promise.resolve()
    },
    close() {
      stop("Claude invocation closed")
    },
    async *[Symbol.asyncIterator]() {
      const source = await Promise.race([start(), aborted])
      const iterator = source[Symbol.asyncIterator]()
      try {
        for (;;) {
          const result = await Promise.race([iterator.next(), aborted])
          if (result.done) break
          yield result.value
        }
      } finally {
        // Iterator.return() can itself hang on a wedged subprocess.
        void Promise.resolve()
          .then(() => iterator.return?.())
          .catch(() => {})
      }
    },
  }
  const q = new Proxy(target, {
    get(object, key, receiver) {
      if (key in object || typeof key === "symbol") return Reflect.get(object, key, receiver)
      if (key === "then") return undefined
      if (raw) {
        const value = Reflect.get(raw, key)
        return typeof value === "function" ? value.bind(raw) : value
      }
      return async (...args: unknown[]) => {
        const live = await Promise.race([start(), aborted])
        const method = Reflect.get(live, key)
        if (typeof method !== "function")
          throw new Error(`Claude SDK control unavailable: ${String(key)}`)
        return method.apply(live, args)
      }
    },
  })
  return {
    q,
    finish() {
      finished = true
      if (timer) clearTimeout(timer)
      timer = undefined
      closeRaw()
    },
  }
}
