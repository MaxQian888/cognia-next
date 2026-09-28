// The renderer and sidecar wire contract share one portable definition.
// This leaf export never imports the Node-only Claude Agent SDK at runtime.
export type { AgentDefinition } from "@cognia/agent-config-types/claude-agent-sdk-options"
