/**
 * Plugin SDK — `resources` capability surface: index-level reads of what the
 * user has configured.
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
 */

export { listCharacters, resolveCharacterById } from "@/lib/db/characters"
export { listTwins } from "@/lib/db/twins"
export { listSkills } from "@/lib/db/skills"
export { listAdapterInstances } from "@/lib/db/adapter-instances"
export { listMcpServers } from "@/lib/db/mcp-servers"
export { listPlugins } from "@/lib/db/plugins"
