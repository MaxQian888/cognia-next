/**
 * Cognia's replacement for Monaco's standalone `IClipboardService`
 * (`BrowserClipboardService`), installed as a service override the first
 * time Monaco initializes its standalone services (see `monaco-loader.ts`).
 *
 * Why replace it: on WebKit (the Tauri macOS shell, Safari) the stock service
 * installs `installWebKitWriteTextWorkaround`, which on EVERY click and keydown
 * in its container pre-arms `navigator.clipboard.write([ClipboardItem(pending)])`.
 * WebKit refuses the write whenever the event carries no user activation
 * (Escape, a bare modifier, …) and Monaco logs each refusal as
 * `NotAllowedError: The request is not allowed by the user agent…`. A refused
 * pre-arm also swallows the next programmatic copy: `writeText` resolves the
 * dead pending item instead of writing.
 *
 * This service keeps the stock semantics (typed in-memory slots, the find
 * buffer, the resources list) but routes real clipboard text through
 * `@/lib/tauri/clipboard`: the native plugin on desktop, the native pasteboard
 * on Capacitor, `navigator.clipboard` in the browser. The native routes need no
 * user activation, so Monaco's context-menu Paste in Tauri reads the clipboard
 * directly instead of raising WebKit's paste-permission bubble.
 *
 * The clipboard helpers are imported lazily: this module is evaluated with the
 * root layout's client graph (`CanvasBridgeProvider` → `monaco-loader.ts`), and
 * the Tauri plugin wrappers have no business in that first chunk.
 */

type ClipboardHelpers = Pick<
  typeof import("@/lib/tauri/clipboard"),
  "readClipboardText" | "writeClipboardText"
>

export type LoadClipboardHelpers = () => Promise<ClipboardHelpers>

const loadDefaultHelpers: LoadClipboardHelpers = () => import("@/lib/tauri/clipboard")

/** Monaco `URI` as far as this service is concerned — stored and handed back as-is. */
type MonacoResource = unknown

/** Matches the stock service's cap on the text it hashes to detect a stale resources list. */
const MAX_RESOURCE_STATE_SOURCE_LENGTH = 1_000

/** Cheap string hash (djb2) — only compared against itself, never persisted. */
function hashText(text: string): number {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return hash
}

/**
 * Last-resort copy when every clipboard backend refused: the hidden-textarea +
 * `execCommand("copy")` path the stock service falls back to as well.
 */
function fallbackWriteText(text: string): void {
  if (typeof document === "undefined" || !document.body) return
  const previous = document.activeElement
  const textarea = document.createElement("textarea")
  textarea.setAttribute("aria-hidden", "true")
  textarea.style.position = "absolute"
  textarea.style.width = "1px"
  textarea.style.height = "1px"
  textarea.value = text
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    document.execCommand("copy")
  } finally {
    textarea.remove()
    if (previous instanceof HTMLElement) previous.focus()
  }
}

/**
 * Structural implementation of Monaco's `IClipboardService`. Monaco resolves
 * services by id, so only the method names and shapes have to match.
 */
export class CogniaMonacoClipboardService {
  declare readonly _serviceBrand: undefined

  private readonly mapTextToType = new Map<string, string>()
  private findText = ""
  private resources: MonacoResource[] = []
  private resourcesStateHash: number | undefined

  constructor(private readonly loadHelpers: LoadClipboardHelpers = loadDefaultHelpers) {}

  /**
   * `undefined` tells Monaco's paste command there is no native paste trigger,
   * so it falls through to `readText()` — which this service serves natively.
   */
  triggerPaste(): Promise<void> | undefined {
    return undefined
  }

  async writeText(text: string, type?: string): Promise<void> {
    this.clearResourcesState()
    if (type) {
      this.mapTextToType.set(type, text)
      return
    }
    try {
      const { writeClipboardText } = await this.loadHelpers()
      await writeClipboardText(text)
      return
    } catch {
      // Every backend refused — fall through to the execCommand path.
    }
    fallbackWriteText(text)
  }

  async readText(type?: string): Promise<string> {
    if (type) return this.mapTextToType.get(type) ?? ""
    try {
      const { readClipboardText } = await this.loadHelpers()
      return (await readClipboardText()) ?? ""
    } catch {
      return ""
    }
  }

  async readFindText(): Promise<string> {
    return this.findText
  }

  async writeFindText(text: string): Promise<void> {
    this.findText = text
  }

  async writeResources(resources: MonacoResource[]): Promise<void> {
    this.resources = resources
    this.resourcesStateHash = await this.computeResourcesStateHash()
  }

  async readResources(): Promise<MonacoResource[]> {
    // The resources are only valid while the clipboard still holds the text
    // that was current when they were written (stock behavior).
    const hash = await this.computeResourcesStateHash()
    if (this.resourcesStateHash !== hash) this.clearResourcesState()
    return this.resources
  }

  async hasResources(): Promise<boolean> {
    return (await this.readResources()).length > 0
  }

  async readImage(): Promise<Uint8Array> {
    return new Uint8Array(0)
  }

  clearInternalState(): void {
    this.clearResourcesState()
  }

  private async computeResourcesStateHash(): Promise<number | undefined> {
    if (this.resources.length === 0) return undefined
    const text = await this.readText()
    return hashText(text.substring(0, MAX_RESOURCE_STATE_SOURCE_LENGTH))
  }

  private clearResourcesState(): void {
    this.resources = []
    this.resourcesStateHash = undefined
  }
}
