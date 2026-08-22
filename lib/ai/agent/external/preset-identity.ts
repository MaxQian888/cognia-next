/**
 * Which preset an external-agent config came from.
 *
 * The preset id is stored on `metadata.preset` (stamped by
 * `createConfigFromPreset` and by the settings form), not as a first-class
 * field — so every reader has to unwrap an `unknown`. Four places did that
 * inline with slightly different guards; the capability profile needs the same
 * answer, and a fifth private copy is how a config whose metadata was written
 * by an older build starts resolving to "no preset" in one surface and a preset
 * in another.
 */

import type { ExternalAgentConfig } from "@/types/agent/external-agent"

export function externalAgentPresetIdOf(
  config: Pick<ExternalAgentConfig, "metadata"> | undefined
): string | undefined {
  const preset = config?.metadata?.preset
  return typeof preset === "string" && preset.length > 0 ? preset : undefined
}
