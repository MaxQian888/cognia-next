/**
 * @cognia/tts — framework-agnostic text-to-speech core (ADR-0068 E3).
 *
 * Consumers deep-import submodules (`@cognia/tts/tts-orchestrator`,
 * `@cognia/tts/providers/registry`, …); this barrel exists as the package
 * entry and for shells that want the whole surface. Platform bridges (native
 * proxy fetch, native-shell gate, notifications) are injected via
 * `setTtsHost` — in cognia-next that's `lib/tts/host-bindings.ts`.
 */

export * from "./types"
export * from "./host"
export * from "./proxy-fetch"
export * from "./retry"
export * from "./tts-text-utils"
export * from "./tts-cache"
export * from "./chunk-pipeline"
export * from "./auto-play-gates"
export * from "./speech"
export * from "./speech-settings"
export * from "./tts-orchestrator"
export * from "./providers/registry"
export * from "./streaming/pcm-player"
