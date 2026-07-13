/**
 * App binding for `@cognia/tts/speech-settings` (ADR-0068 E3): keeps the
 * historical `@/lib/tts/speech-settings` specifier stable. The package
 * selector takes a structural `SpeechSettingsSource`; AppSettings satisfies
 * it directly (the TTS fields live flat on the settings row).
 */

import "./host-bindings"

export * from "@cognia/tts/speech-settings"
