/**
 * `window.state` and `window.activeColorTheme`: whether the app's window is
 * focused and in use, and whether its theme is light or dark.
 *
 * The renderer owns both. The host asks for them once, before the first
 * extension activates (`window:describeEnvironment`), and the renderer tells
 * it whenever either changes (`window:environmentChanged`). Until the first
 * answer the window counts as focused, active and dark; a renderer that
 * cannot answer leaves those values in place and the failure is logged.
 */

import type { RpcConnection } from "../rpc"
import { ColorThemeKind } from "./api-types"
import { EventEmitter } from "./types"

export interface WindowState {
  readonly focused: boolean
  readonly active: boolean
}

export interface ColorTheme {
  readonly kind: (typeof ColorThemeKind)[keyof typeof ColorThemeKind]
}

/** What the renderer reports. */
export interface WindowEnvironmentReport {
  focused: boolean
  active: boolean
  colorThemeKind: number
}

const THEME_KINDS = new Set<number>(Object.values(ColorThemeKind))

export class WindowEnvironment {
  state: WindowState = { focused: true, active: true }
  colorTheme: ColorTheme = { kind: ColorThemeKind.Dark }
  readonly onDidChangeState = new EventEmitter<WindowState>()
  readonly onDidChangeColorTheme = new EventEmitter<ColorTheme>()
  private loading: Promise<void> | null = null

  attach(connection: RpcConnection): void {
    connection.onRequest("window:environmentChanged", (params) => {
      this.apply(params)
      return null
    })
  }

  /** Ask the renderer once; later calls wait for the same answer. */
  load(connection: RpcConnection, warn: (message: string) => void): Promise<void> {
    this.loading ??= connection
      .sendRequest<unknown>("window:describeEnvironment", {})
      .then((report) => this.apply(report))
      .catch((error: unknown) => {
        warn(
          `could not read the window's focus and theme (${error instanceof Error ? error.message : String(error)}); extensions see a focused, dark window`
        )
      })
    return this.loading
  }

  /** Take a report, firing each event whose value changed. Malformed fields are ignored. */
  apply(report: unknown): void {
    if (!report || typeof report !== "object") return
    const { focused, active, colorThemeKind } = report as Partial<WindowEnvironmentReport>
    const state = {
      focused: typeof focused === "boolean" ? focused : this.state.focused,
      active: typeof active === "boolean" ? active : this.state.active,
    }
    if (state.focused !== this.state.focused || state.active !== this.state.active) {
      this.state = state
      this.onDidChangeState.fire(state)
    }
    if (
      typeof colorThemeKind === "number" &&
      THEME_KINDS.has(colorThemeKind) &&
      colorThemeKind !== this.colorTheme.kind
    ) {
      this.colorTheme = { kind: colorThemeKind as ColorTheme["kind"] }
      this.onDidChangeColorTheme.fire(this.colorTheme)
    }
  }
}
