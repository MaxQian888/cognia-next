/**
 * App binding for `@cognia/tts/tts-orchestrator` (ADR-0068 E3): keeps the
 * historical `@/lib/tts/tts-orchestrator` specifier stable and guarantees the
 * host bridges (Tauri proxy fetch, native-shell gate, sonner toasts) are
 * installed before the orchestrator synthesizes anything.
 */

import "./host-bindings"

export * from "@cognia/tts/tts-orchestrator"
