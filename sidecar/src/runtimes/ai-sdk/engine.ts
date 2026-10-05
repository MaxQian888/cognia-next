// The AI SDK engine as the host loads it (ADR-0217), behind one dynamic
// import in `runtimes/engines.ts`.

export { dispatchAiSdk as dispatch } from "./index.ts"
