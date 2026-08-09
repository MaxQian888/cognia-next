import type { Screenshot } from "@/lib/automation/types"
import type {
  BrowserActionResult,
  BrowserSnapshot,
  ConsoleEntry,
  EvaluateResult,
  NetworkEntry,
  SnapshotOptions,
} from "@/lib/browser/protocol"
import type { BrowserDownloadSummary, BrowserPageSummary } from "@/lib/browser/session-types"
import { transport } from "@/lib/tauri/transport-instance"

import type {
  BrowserEngine,
  BrowserMutationResult,
  BrowserZoomResult,
  FindOptions,
  HandleDialogArgs,
  NetworkIdleOptions,
  ScrollArgs,
  ScreenshotOptions,
  WaitForLoadOptions,
  WaitForOptions,
  WaitForResult,
} from "./agent-engine"

/** Companion-RPC adapter; Playwright and CDP remain private to WorkspaceRuntime. */
export class RemoteChromiumEngine implements BrowserEngine {
  constructor(private readonly browserSessionId: string) {}

  private call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return transport.call<T>(name, { browserSessionId: this.browserSessionId, ...args })
  }

  navigate(url: string): Promise<void | BrowserMutationResult> {
    return this.call("browser_navigate", { url })
  }
  snapshot(options?: SnapshotOptions): Promise<BrowserSnapshot> {
    return this.call("browser_snapshot", { options })
  }
  act(ref: string, action: string, args: Record<string, unknown>): Promise<BrowserActionResult> {
    return this.call("browser_act", { ref, action, args })
  }
  pressKey(key: string, ref?: string): Promise<BrowserActionResult> {
    return this.call("browser_press_key", { key, ref })
  }
  scroll(args: ScrollArgs): Promise<BrowserActionResult> {
    return this.call("browser_scroll", args as Record<string, unknown>)
  }
  evaluate(expression: string): Promise<EvaluateResult> {
    return this.call("browser_evaluate", { expression })
  }
  readConsole(): Promise<ConsoleEntry[]> {
    return this.call("browser_read_console")
  }
  readNetwork(): Promise<NetworkEntry[]> {
    return this.call("browser_read_network")
  }
  back(): Promise<void | BrowserMutationResult> {
    return this.call("browser_back")
  }
  forward(): Promise<void | BrowserMutationResult> {
    return this.call("browser_forward")
  }
  reload(): Promise<void | BrowserMutationResult> {
    return this.call("browser_reload")
  }
  stop(): Promise<void | BrowserMutationResult> {
    return this.call("browser_stop")
  }
  getPage(): Promise<{ url: string; title: string }> {
    return this.call("browser_get_page")
  }
  listPages(): Promise<BrowserPageSummary[]> {
    return this.call("browser_pages")
  }
  activatePage(pageId: string): Promise<void> {
    return this.call("browser_switch_page", { pageId })
  }
  closePage(pageId: string): Promise<void> {
    return this.call("browser_close_page", { pageId })
  }
  createPage(url?: string): Promise<BrowserPageSummary | BrowserActionResult> {
    return this.call("browser_new_page", { url })
  }
  drag(sourceRef: string, targetRef: string): Promise<BrowserActionResult> {
    return this.call("browser_drag", { sourceRef, targetRef })
  }
  handleDialog(args: HandleDialogArgs): Promise<BrowserActionResult> {
    return this.call("browser_handle_dialog", {
      accept: args.accept,
      ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
    })
  }
  setFiles(ref: string, paths: string[]): Promise<void | BrowserMutationResult> {
    return this.call("browser_set_files", { ref, paths })
  }
  downloads(): Promise<BrowserDownloadSummary[]> {
    return this.call("browser_downloads")
  }
  waitForText(text: string, options?: WaitForOptions): Promise<WaitForResult> {
    return this.call("browser_wait_for", { text, options })
  }
  waitForSelector(selector: string, options?: WaitForOptions): Promise<WaitForResult> {
    return this.call("browser_wait_for", { selector, options })
  }
  waitForNetworkIdle(options?: NetworkIdleOptions): Promise<WaitForResult> {
    return this.call("browser_wait_for", { networkIdle: true, options })
  }
  waitForLoad(options?: WaitForLoadOptions): Promise<WaitForResult> {
    return this.call("browser_wait_for_load", { options })
  }
  screenshot(options?: ScreenshotOptions): Promise<Screenshot> {
    return this.call("browser_screenshot", options ? { options } : {})
  }
  setZoom(zoom: number): Promise<BrowserZoomResult> {
    return this.call("browser_set_zoom", { zoom })
  }
  find(query: string, options?: FindOptions): Promise<{ matches: number; index: number }> {
    return this.call("browser_find", { query, options })
  }
  findClear(): Promise<void> {
    return this.call("browser_find_clear")
  }
}
