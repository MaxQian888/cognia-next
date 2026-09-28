// @ts-check
import "./src/platform/net/install-fetch-interceptor.ts"
export * from "./src/entry/agent-host.ts"
import { runAgentHostEntry } from "./src/entry/agent-host.ts"
runAgentHostEntry(import.meta.url)
