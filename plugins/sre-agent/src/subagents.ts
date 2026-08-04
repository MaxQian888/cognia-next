import { defineSubagent } from "@cognia/plugin-sdk"
import type { PluginManifest } from "@/types/plugin"
import manifestJson from "../plugin.json"

type ManifestSubagent = NonNullable<PluginManifest["subagents"]>[number]

/** Subagents materialized in the packaged manifest and projected by the host. */
export const SRE_SUBAGENTS = (manifestJson.subagents as ManifestSubagent[]).map(defineSubagent)

/** Canonical system prompt from the packaged manifest. */
export const SRE_SYSTEM_PROMPT = SRE_SUBAGENTS[0].prompt

/** Production-mutating tools explicitly denied to the SRE subagent. */
export const SRE_DISALLOWED_TOOLS = SRE_SUBAGENTS[0].disallowedTools as string[]
