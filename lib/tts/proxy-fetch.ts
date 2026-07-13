/**
 * App binding for `@cognia/tts/proxy-fetch` (ADR-0068 E3): keeps the
 * historical `@/lib/tts/proxy-fetch` specifier stable and guarantees the
 * Tauri host bridges are installed (side-effect import) before any provider
 * fetch runs.
 */

import "./host-bindings"

export * from "@cognia/tts/proxy-fetch"
