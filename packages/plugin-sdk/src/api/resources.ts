/**
 * Type surface for index-level reads through `ctx.resources`.
 *
 * An agent that builds a workflow, a team or a scheduled task has to reference
 * real ids — this character, that MCP server, that skill. Guessing produces
 * plausible configurations that fail at run time, so grounding the proposal in
 * the actual inventory is the difference between a copilot and a hallucination
 * engine.
 *
 * INDEX level, deliberately: id, label, and a few capability tags. Credentials,
 * raw system prompts, keyring refs and webhook URLs are not part of any of
 * these rows' public shape, and a plugin that needs one of those needs a
 * permission, not a list.
 *
 * This subpath intentionally exports no database functions. The activated,
 * governed context is the only runtime door to the host inventory.
 */

export type { PluginResourcesAPI } from "@/lib/plugin/api/resources-api"
