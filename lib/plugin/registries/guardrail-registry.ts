/**
 * Guardrail Registry — dynamic overlay for plugin-registered agent guardrails
 * (ADR-0026 §Agent-SDK, Package B).
 *
 * Plugins register reusable guardrails imperatively via
 * `ctx.agent.guardrails.register(...)`. A run opts into them by id through
 * `PluginAgentRunOptions.guardrails`. On plugin disable the manager calls
 * `unregisterGuardrailsByPlugin(pluginId)` to drop them all.
 *
 * Runtime resolution + execution lives in `lib/plugin/agent-sdk/guardrails.ts`.
 */

import type { PluginGuardrail } from "@/types/plugin/plugin-agent-guardrails"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginGuardrail>({ name: "guardrail" })

/** Register a plugin-contributed guardrail. */
export const registerGuardrail = registry.register
/** Drop a single guardrail by id. */
export const unregisterGuardrailById = registry.unregisterById
/** Drop every guardrail contributed by `pluginId`. Returns the number removed. */
export const unregisterGuardrailsByPlugin = registry.unregisterByPlugin
/** Get a guardrail by id. Returns undefined when not registered. */
export const getGuardrail = registry.get
/** List every registered guardrail id in registration order. */
export const listGuardrailIds = registry.list
/** List every registered entry (id + guardrail + pluginId). */
export const listGuardrailEntries = registry.entries
/** Test-only: clear every registered guardrail. */
export const __resetGuardrailsForTesting = registry.__resetForTesting
