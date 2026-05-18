/**
 * OCR runtime bootstrap.
 *
 * Wires every provider in `lib/ocr/providers/*` into the shared registry and
 * connects the platform-native providers to their respective Tauri / Capacitor
 * invokers. Called once from the app's client-side entry point — see
 * `app/(setup)/ocr-bootstrap.tsx`.
 *
 * Provider files self-register through their factory exports rather than via
 * `import './providers/foo'` side effects so the static export's tree-shaker
 * has full visibility.
 */

import { registerOcrProvider, getSharedOcrRegistry } from "./registry"
import { mistralOcrProvider } from "./providers/mistral-ocr"
import { googleVisionProvider } from "./providers/google-vision"
import { awsTextractProvider } from "./providers/aws-textract"
import { azureDocIntelligenceProvider } from "./providers/azure-document-intelligence"
import { anthropicVisionProvider } from "./providers/anthropic-vision"
import { openAiVisionProvider } from "./providers/openai-vision"
import { geminiVisionProvider } from "./providers/gemini-vision"
import { mathpixProvider } from "./providers/mathpix"
import { ocrSpaceProvider } from "./providers/ocr-space"
import { abbyyCloudProvider } from "./providers/abbyy-cloud"
import { nanonetsProvider } from "./providers/nanonets"
import { larkBasicProvider } from "./providers/lark-basic"
import { tesseractWasmProvider } from "./providers/tesseract-wasm"
import { tesseractNativeProvider } from "./providers/tesseract-native"
import {
  __setNativeOcrInvoker,
  type NativeOcrInvoker,
  type NativeOcrInvokePayload,
  type NativeOcrResult,
} from "./providers/tesseract-native"
import {
  __setWindowsMediaOcrInvoker,
  __setWindowsMediaOcrReadiness,
  windowsMediaOcrProvider,
} from "./providers/windows-media-ocr"
import { __setAppleVisionTauriInvoker, appleVisionProvider } from "./providers/apple-vision"
import { mlkitAndroidProvider } from "./providers/mlkit-android"

const ALL_PROVIDERS = [
  mistralOcrProvider,
  googleVisionProvider,
  awsTextractProvider,
  azureDocIntelligenceProvider,
  anthropicVisionProvider,
  openAiVisionProvider,
  geminiVisionProvider,
  mathpixProvider,
  ocrSpaceProvider,
  abbyyCloudProvider,
  nanonetsProvider,
  larkBasicProvider,
  tesseractWasmProvider,
  tesseractNativeProvider,
  windowsMediaOcrProvider,
  appleVisionProvider,
  mlkitAndroidProvider,
]

let installed = false

export interface OcrRuntimeOptions {
  /** Inject a custom invoker — typically only used in tests. */
  nativeInvoker?: NativeOcrInvoker
  /** Inject a custom MSIX-status probe. Defaults to the Tauri command. */
  windowsReadinessProbe?: () => Promise<boolean>
}

/**
 * Install every provider into the shared registry and wire platform-native
 * invokers. Idempotent — calling twice is a no-op.
 */
export async function installOcrRuntime(opts: OcrRuntimeOptions = {}): Promise<void> {
  if (installed) return
  installed = true
  const registry = getSharedOcrRegistry()
  for (const provider of ALL_PROVIDERS) {
    if (registry.has(provider.id)) continue
    registerOcrProvider(provider)
  }

  const invoker = opts.nativeInvoker ?? (await tryBuildTauriInvoker())
  if (invoker) {
    __setNativeOcrInvoker(invoker)
    __setWindowsMediaOcrInvoker(invoker)
    __setAppleVisionTauriInvoker(invoker)
  }

  const readinessProbe = opts.windowsReadinessProbe ?? (await tryBuildMsixProbe())
  if (readinessProbe) {
    __setWindowsMediaOcrReadiness(readinessProbe)
  }
}

/** Reset state — test-only. */
export function __resetOcrRuntime(): void {
  installed = false
  __setNativeOcrInvoker(null)
  __setWindowsMediaOcrInvoker(null)
  __setWindowsMediaOcrReadiness(null)
  __setAppleVisionTauriInvoker(null)
}

async function tryBuildTauriInvoker(): Promise<NativeOcrInvoker | null> {
  if (typeof window === "undefined") return null
  if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return null
  try {
    const { invoke } = (await import("@tauri-apps/api/core")) as {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    }
    return async (payload: NativeOcrInvokePayload) => {
      return invoke<NativeOcrResult>("ocr_extract_native", {
        payload: {
          backend: payload.backend,
          // Tauri serializes Uint8Array as a number array transparently.
          bytes: Array.from(payload.bytes),
          mime_type: payload.mimeType,
          languages: payload.languages,
        },
      })
    }
  } catch {
    return null
  }
}

async function tryBuildMsixProbe(): Promise<(() => Promise<boolean>) | null> {
  if (typeof window === "undefined") return null
  if (!("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>))) return null
  try {
    const { invoke } = (await import("@tauri-apps/api/core")) as {
      invoke: <T>(cmd: string) => Promise<T>
    }
    return async () => {
      try {
        const status = await invoke<{ has_package_identity?: boolean }>("ocr_msix_status")
        return !!status?.has_package_identity
      } catch {
        return false
      }
    }
  } catch {
    return null
  }
}
