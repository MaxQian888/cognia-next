/**
 * Resolution and validation for {@link SandboxSessionBinding}.
 *
 * Precedence is the repo's usual session → character → app-settings ladder,
 * resolved independently per axis and then reconciled, because the two axes
 * came from settings that never knew about each other:
 *
 *   * shell tier   ← `ChatSession.sandboxTier` → `Character.sandboxTier` → `AppSettings.sandboxTier`
 *   * GUI target   ← `ChatSession.computerUseTarget` → `Character.computerUseTarget` → local
 *
 * Reconciliation is where the `cua-desktop` tier earns its keep: choosing it
 * means "run everything in that desktop", so it forces `computerTarget` to
 * `"bound"` on the same connection. The inverse is deliberately NOT true — a
 * bound GUI target with an `"os"` shell tier is a legitimate setup (drive a
 * remote desktop, keep the build on the host), so it is left alone.
 */

import type {
  SandboxComputerTarget,
  SandboxSessionBinding,
  SandboxShellTier,
} from "@/types/sandbox"
import type { ComputerUseTargetSetting } from "@/lib/automation/sandbox-target"
import { resolveComputerUseTarget } from "@/lib/automation/sandbox-target"

/** Stored shell-tier form. `undefined` = inherit from the next layer down. */
export type SandboxTierSetting = SandboxShellTier | undefined

export interface SandboxBindingInputs {
  session?: {
    sandboxTier?: SandboxTierSetting
    computerUseTarget?: ComputerUseTargetSetting
  }
  character?: {
    sandboxTier?: SandboxTierSetting
    computerUseTarget?: ComputerUseTargetSetting
  }
  appSettings?: {
    sandboxTier?: SandboxShellTier
  }
}

/** Why a binding is not usable. */
export type SandboxBindingViolation =
  "bound-target-without-connection" | "cua-desktop-without-connection"

export type SandboxBindingValidation =
  { ok: true } | { ok: false; violation: SandboxBindingViolation; message: string }

/**
 * Resolve the raw settings ladders into a single binding. Always returns a
 * *structurally* valid binding — the `cua-desktop`/`bound` reconciliation
 * happens here — but a binding can still be *unusable* when the connection id
 * it needs is missing; call {@link validateSandboxSessionBinding} before
 * activating it.
 */
export function resolveSandboxSessionBinding(inputs: SandboxBindingInputs): SandboxSessionBinding {
  const shellTier: SandboxShellTier =
    inputs.session?.sandboxTier ??
    inputs.character?.sandboxTier ??
    inputs.appSettings?.sandboxTier ??
    "os"

  const target = resolveComputerUseTarget(
    inputs.session?.computerUseTarget,
    inputs.character?.computerUseTarget
  )

  let computerTarget: SandboxComputerTarget = target.kind === "remote" ? "bound" : "local"
  let connectionId = target.kind === "remote" ? target.connectionId : undefined

  // `cua-desktop` means shell/file AND GUI run inside the bound desktop. If the
  // GUI axis was left local, promote it rather than silently splitting
  // execution across two machines.
  if (shellTier === "cua-desktop") {
    computerTarget = "bound"
    connectionId = connectionId ?? undefined
  }

  return {
    shellTier,
    computerTarget,
    ...(connectionId ? { connectionId } : {}),
  }
}

/**
 * Isolation strength, ascending. `cua-desktop` outranks `microvm` because it
 * moves shell, file AND GUI work off the host, where `microvm` still leaves the
 * GUI axis local.
 *
 * Exists so a *change* of tier can be classified. Resolution alone cannot say
 * whether a session just lost isolation, and "lost isolation" is the one
 * transition that must never happen quietly.
 */
export const SANDBOX_ISOLATION_RANK: Record<SandboxShellTier, number> = {
  os: 1,
  microvm: 2,
  "cua-desktop": 3,
}

/** How `next` compares to `prev` on the isolation axis. */
export type SandboxIsolationChange = "same" | "stronger" | "weaker"

export function compareSandboxIsolation(
  prev: SandboxShellTier,
  next: SandboxShellTier
): SandboxIsolationChange {
  const delta = SANDBOX_ISOLATION_RANK[next] - SANDBOX_ISOLATION_RANK[prev]
  return delta === 0 ? "same" : delta > 0 ? "stronger" : "weaker"
}

/** Which rung of the ladder supplied the resolved shell tier. */
export type SandboxTierSource = "session" | "character" | "appSettings" | "fallback"

/**
 * The provenance of {@link resolveSandboxSessionBinding}'s `shellTier`.
 *
 * Deliberately NOT a field on {@link SandboxSessionBinding}: that shape is
 * handed to `sandboxSessionRuntime.bindSession` and compared across binds, so
 * widening it would make provenance part of the binding's identity. Provenance
 * is a question about the *inputs*, so it is answered from the inputs.
 *
 * The caller that matters is the pin: a tier resolved from anything other than
 * `"session"` is one that will silently re-resolve when the layer beneath it
 * changes.
 */
export function resolveSandboxTierSource(inputs: SandboxBindingInputs): SandboxTierSource {
  if (inputs.session?.sandboxTier) return "session"
  if (inputs.character?.sandboxTier) return "character"
  if (inputs.appSettings?.sandboxTier) return "appSettings"
  return "fallback"
}

/**
 * Check the two invariants. A violation is a refusal, never a downgrade: a
 * `cua-desktop` binding with no connection must not quietly become `"os"`,
 * because the user asked for isolation and would not be told they lost it.
 */
export function validateSandboxSessionBinding(
  binding: SandboxSessionBinding
): SandboxBindingValidation {
  if (binding.shellTier === "cua-desktop" && !binding.connectionId) {
    return {
      ok: false,
      violation: "cua-desktop-without-connection",
      message:
        'The "cua-desktop" sandbox tier runs shell, file and GUI work inside a bound sandbox connection, but no connection is selected.',
    }
  }
  if (binding.computerTarget === "bound" && !binding.connectionId) {
    return {
      ok: false,
      violation: "bound-target-without-connection",
      message: "Computer Use is set to a bound sandbox connection, but no connection is selected.",
    }
  }
  return { ok: true }
}

/** Does this binding route shell / file tools away from the host? */
export function bindingRoutesWorkspaceToConnection(binding: SandboxSessionBinding): boolean {
  return binding.shellTier === "cua-desktop" && !!binding.connectionId
}

/** Does this binding route Computer Use away from the host desktop? */
export function bindingRoutesGuiToConnection(binding: SandboxSessionBinding): boolean {
  return binding.computerTarget === "bound" && !!binding.connectionId
}

/**
 * Operations the bound connection must support before this binding can be
 * activated. A `cua-desktop` binding needs both the workspace and GUI surfaces;
 * a bound-GUI-only binding needs just the GUI one.
 */
export function requiredOperationsForBinding(
  binding: SandboxSessionBinding
): readonly ("gui" | "workspaceExec")[] {
  const required: ("gui" | "workspaceExec")[] = []
  if (bindingRoutesGuiToConnection(binding)) required.push("gui")
  if (bindingRoutesWorkspaceToConnection(binding)) required.push("workspaceExec")
  return required
}

/** The binding used when nothing is configured: everything on the host. */
export const DEFAULT_SANDBOX_SESSION_BINDING: SandboxSessionBinding = Object.freeze({
  shellTier: "os",
  computerTarget: "local",
})
