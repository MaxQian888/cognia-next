/**
 * Plugin Agent SDK — guardrail runtime (ADR-0026 §Agent-SDK, Package B).
 *
 * Runs input guardrails before a turn and output guardrails after it, around
 * `runPluginAgent` / `runPluginAgentStreamed`. A tripped guardrail aborts the
 * run by throwing {@link PluginGuardrailTripwireError}. Channel-agnostic — these
 * run on both the sidecar and text channels.
 *
 * Permission-agnostic (gating stays in `context.ts`); resolves string ids
 * against the guardrail overlay registry so plugins can reuse registered
 * guardrails alongside inline ones.
 */

import { getGuardrail } from "@/lib/plugin/registries/guardrail-registry"
import type {
  PluginGuardrail,
  PluginInputGuardrail,
  PluginOutputGuardrail,
} from "@/types/plugin/plugin-agent-guardrails"

/** Thrown when a guardrail trips its tripwire. Carries the stage + guardrail id. */
export class PluginGuardrailTripwireError extends Error {
  constructor(
    readonly stage: "input" | "output",
    readonly guardrailId: string,
    message: string
  ) {
    super(message)
    this.name = "PluginGuardrailTripwireError"
  }
}

/** Resolve inline guardrails + registered ids into concrete guardrails. */
function resolveGuardrails(list: Array<PluginGuardrail | string> | undefined): PluginGuardrail[] {
  const out: PluginGuardrail[] = []
  for (const g of list ?? []) {
    if (typeof g === "string") {
      const found = getGuardrail(g)
      if (found) out.push(found)
    } else {
      out.push(g)
    }
  }
  return out
}

/**
 * Run the input guardrails for a turn. Throws {@link PluginGuardrailTripwireError}
 * on the first tripwire so the turn never starts.
 */
export async function runInputGuardrails(
  prompt: string,
  guardrails: Array<PluginGuardrail | string> | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  const inputs = resolveGuardrails(guardrails).filter(
    (g): g is PluginInputGuardrail => g.type === "input"
  )
  for (const g of inputs) {
    const r = await g.run({ prompt, ...(signal ? { signal } : {}) })
    if (r.tripwireTriggered) {
      throw new PluginGuardrailTripwireError(
        "input",
        g.id,
        r.message ?? `input guardrail "${g.id}" tripped`
      )
    }
  }
}

/**
 * Run the output guardrails for a turn. Throws {@link PluginGuardrailTripwireError}
 * on the first tripwire so a leaking/invalid reply never reaches the caller.
 */
export async function runOutputGuardrails(
  prompt: string,
  output: string,
  guardrails: Array<PluginGuardrail | string> | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  const outputs = resolveGuardrails(guardrails).filter(
    (g): g is PluginOutputGuardrail => g.type === "output"
  )
  for (const g of outputs) {
    const r = await g.run({ prompt, output, ...(signal ? { signal } : {}) })
    if (r.tripwireTriggered) {
      throw new PluginGuardrailTripwireError(
        "output",
        g.id,
        r.message ?? `output guardrail "${g.id}" tripped`
      )
    }
  }
}

/**
 * Built-in output guardrail: trips when the final reply contains PII the
 * twin redaction gate would flag. Generalizes the PII concern from the
 * tool-arg `createPiiRedactionGate` onto the agent's textual output.
 */
export function createPiiOutputGuardrail(): PluginOutputGuardrail {
  return {
    id: "builtin:pii-output",
    name: "PII output guardrail",
    type: "output",
    run: async ({ output }) => {
      const { hasNoLeakingPii } = await import("@/lib/twin/ingest/redact")
      return hasNoLeakingPii(output)
        ? { tripwireTriggered: false }
        : {
            tripwireTriggered: true,
            message: "output contains personally identifiable information",
          }
    },
  }
}
