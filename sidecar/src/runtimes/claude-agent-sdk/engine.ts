// The Claude Agent SDK engine as the host loads it (ADR-0217): everything
// the host reaches in this rail, behind one dynamic import in
// `runtimes/engines.ts`, so a host that does not load it never imports the
// Claude Agent SDK.

export { dispatchAnthropic as dispatch } from "./index.ts"
export { handleSessionApi } from "./session-api.ts"
export { sessionStoreFromSendOptions } from "./session-store.ts"
