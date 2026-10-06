import { installConsoleBridge } from "@cognia/logging/console-bridge"

// Next.js executes this module before hydration, so legacy console calls made
// while client modules initialize are routed through the unified logger too.
// Keep this pre-hydration hook lightweight; the app bootstrap attaches storage
// and network transports later. Instrumentation must never prevent rendering.
try {
  installConsoleBridge()
} catch {
  // Fail open if a restricted WebView prevents console replacement.
}
