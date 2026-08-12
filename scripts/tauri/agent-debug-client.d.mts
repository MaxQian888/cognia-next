/// <reference types="node" />

export type TimeoutOption = { timeout?: number }
export type ActionOption = TimeoutOption & { force?: boolean; trial?: boolean }
export type LocatorState = "attached" | "detached" | "visible" | "hidden"
export type TextMatcher = string | RegExp

export interface TauriDebugCapabilities {
  apiVersion?: number
  transport?: string
  locatorAutoWait?: boolean
  locatorStrictness?: boolean
  actionability?: string[]
  stablePositionCheck?: boolean
  receivesEventsCheck?: boolean
  semanticLocators?: boolean
  multiWindow?: boolean
  nativeScreenshot?: boolean
  consoleCapture?: string
  networkCapture?: string
  networkMocking?: string
  dialogs?: boolean
  fileUpload?: boolean
  keyboard?: string
  mouse?: string
  trustedEvents?: boolean
  video?: boolean
  cdp?: boolean
}

export interface WindowInfo {
  label: string
  url?: string
  title?: string
  visible?: boolean
  focused?: boolean
}

export interface RoleOptions {
  name?: TextMatcher
  exact?: boolean
  checked?: boolean
  disabled?: boolean
  expanded?: boolean
  includeHidden?: boolean
  level?: number
  pressed?: boolean
  selected?: boolean
}

export interface FilePayload {
  name: string
  mimeType?: string
  buffer: Buffer | Uint8Array | string
}

export class TauriDebugUnsupportedError extends Error {
  readonly feature: string
  constructor(feature: string, detail?: string)
}

export class TauriLocator {
  first(): TauriLocator
  last(): TauriLocator
  nth(index: number): TauriLocator
  all(): Promise<TauriLocator[]>
  filter(options: { hasText?: TextMatcher; hasNotText?: TextMatcher }): TauriLocator
  locator(selector: string): TauriLocator
  getByTestId(testId: string): TauriLocator
  getByPlaceholder(text: string, options?: { exact?: boolean }): TauriLocator
  getByAltText(text: string, options?: { exact?: boolean }): TauriLocator
  getByTitle(text: string, options?: { exact?: boolean }): TauriLocator
  getByLabel(text: string, options?: { exact?: boolean }): TauriLocator
  getByText(text: TextMatcher, options?: { exact?: boolean }): TauriLocator
  getByRole(role: string, options?: RoleOptions): TauriLocator

  click(options?: ActionOption): Promise<unknown>
  tap(options?: ActionOption): Promise<unknown>
  dblclick(options?: ActionOption): Promise<unknown>
  focus(options?: ActionOption): Promise<unknown>
  blur(options?: ActionOption): Promise<unknown>
  hover(options?: ActionOption): Promise<unknown>
  fill(value: string, options?: ActionOption): Promise<unknown>
  clear(options?: ActionOption): Promise<unknown>
  press(key: string, options?: ActionOption): Promise<unknown>
  check(options?: ActionOption): Promise<unknown>
  uncheck(options?: ActionOption): Promise<unknown>
  selectOption(
    values:
      | string
      | { value?: string; label?: string }
      | Array<string | { value?: string; label?: string }>,
    options?: ActionOption
  ): Promise<unknown>
  type(text: string, options?: ActionOption & { delay?: number }): Promise<unknown>
  pressSequentially(text: string, options?: ActionOption & { delay?: number }): Promise<unknown>
  dragTo(target: TauriLocator, options?: ActionOption): Promise<unknown>
  scrollIntoViewIfNeeded(options?: ActionOption): Promise<unknown>
  dispatchEvent(type: string, eventInit?: unknown, options?: ActionOption): Promise<unknown>
  setInputFiles(
    files: string | FilePayload | Array<string | FilePayload>,
    options?: ActionOption
  ): Promise<unknown>

  count(): Promise<number>
  allTextContents(): Promise<string[]>
  allInnerTexts(): Promise<string[]>
  textContent(options?: TimeoutOption): Promise<string | null>
  innerText(options?: TimeoutOption): Promise<string>
  innerHTML(options?: TimeoutOption): Promise<string>
  inputValue(options?: TimeoutOption): Promise<string>
  getAttribute(name: string, options?: TimeoutOption): Promise<string | null>
  boundingBox(
    options?: TimeoutOption
  ): Promise<{ x: number; y: number; width: number; height: number } | null>
  getComputedStyle(property: string, options?: TimeoutOption): Promise<string>
  evaluate<T = unknown, A = unknown>(
    pageFunction: (element: Element, arg: A) => T | Promise<T>,
    arg?: A,
    options?: TimeoutOption
  ): Promise<T>
  isVisible(): Promise<boolean>
  isHidden(): Promise<boolean>
  isEnabled(): Promise<boolean>
  isDisabled(): Promise<boolean>
  isEditable(): Promise<boolean>
  isChecked(): Promise<boolean>
  isFocused(): Promise<boolean>
  waitFor(options?: number | (TimeoutOption & { state?: LocatorState })): Promise<void>
}

export interface TauriKeyboard {
  press(key: string, options?: { delay?: number }): Promise<void>
  down(key: string): Promise<void>
  up(key: string): Promise<void>
  type(text: string, options?: { delay?: number }): Promise<void>
  insertText(text: string): Promise<void>
}

export interface TauriMouse {
  click(
    x: number,
    y: number,
    options?: { button?: "left" | "right" | "middle"; clickCount?: number }
  ): Promise<void>
  dblclick(x: number, y: number, options?: { button?: "left" | "right" | "middle" }): Promise<void>
  move(x: number, y: number, options?: { steps?: number }): Promise<void>
  down(options?: { button?: "left" | "right" | "middle" }): Promise<void>
  up(options?: { button?: "left" | "right" | "middle" }): Promise<void>
  wheel(deltaX: number, deltaY: number): Promise<void>
}

export interface TauriPageOptions {
  endpoint?: { baseUrl: string; devToken: string }
  window?: string
  fetchImpl?: typeof fetch
  defaultTimeout?: number
}

export class TauriPage {
  readonly keyboard: TauriKeyboard
  readonly mouse: TauriMouse
  readonly targetWindow: string
  defaultTimeout: number
  constructor(options?: TauriPageOptions)
  setDefaultTimeout(timeout: number): void
  capabilities(): Promise<TauriDebugCapabilities>
  locator(selector: string): TauriLocator
  getByTestId(testId: string): TauriLocator
  getByPlaceholder(text: string, options?: { exact?: boolean }): TauriLocator
  getByAltText(text: string, options?: { exact?: boolean }): TauriLocator
  getByTitle(text: string, options?: { exact?: boolean }): TauriLocator
  getByLabel(text: string, options?: { exact?: boolean }): TauriLocator
  getByText(text: TextMatcher, options?: { exact?: boolean }): TauriLocator
  getByRole(role: string, options?: RoleOptions): TauriLocator
  evaluate<T = unknown, A = unknown>(
    pageFunction: string | ((arg: A) => T | Promise<T>),
    arg?: A
  ): Promise<T>
  snapshot(options?: {
    includeText?: boolean
    includeHidden?: boolean
    selector?: string
  }): Promise<unknown>
  url(): Promise<string>
  title(): Promise<string>
  content(): Promise<string>
  goto(url: string, options?: TimeoutOption & { waitUntil?: string }): Promise<{ url: string }>
  reload(options?: TimeoutOption & { waitUntil?: string }): Promise<void>
  goBack(options?: TimeoutOption & { waitUntil?: string }): Promise<void>
  goForward(options?: TimeoutOption & { waitUntil?: string }): Promise<void>
  waitForURL(pattern: TextMatcher, options?: TimeoutOption): Promise<void>
  waitForLoadState(
    state?: "domcontentloaded" | "load" | "networkidle",
    options?: TimeoutOption
  ): Promise<void>
  waitForSelector(
    selector: string,
    options?: number | (TimeoutOption & { state?: LocatorState })
  ): Promise<void>
  waitForFunction<T = unknown, A = unknown>(
    pageFunction: string | ((arg: A) => T),
    arg?: A,
    options?: TimeoutOption & { polling?: number }
  ): Promise<T>
  waitForTimeout(milliseconds: number): Promise<void>

  click(selector: string, options?: ActionOption): Promise<unknown>
  dblclick(selector: string, options?: ActionOption): Promise<unknown>
  hover(selector: string, options?: ActionOption): Promise<unknown>
  fill(selector: string, value: string, options?: ActionOption): Promise<unknown>
  type(
    selector: string,
    value: string,
    options?: ActionOption & { delay?: number }
  ): Promise<unknown>
  press(selector: string, key: string, options?: ActionOption): Promise<unknown>
  check(selector: string, options?: ActionOption): Promise<unknown>
  uncheck(selector: string, options?: ActionOption): Promise<unknown>
  selectOption(selector: string, value: unknown, options?: ActionOption): Promise<unknown>
  focus(selector: string, options?: ActionOption): Promise<unknown>
  blur(selector: string, options?: ActionOption): Promise<unknown>
  dispatchEvent(
    selector: string,
    type: string,
    eventInit?: unknown,
    options?: ActionOption
  ): Promise<unknown>
  dragAndDrop(source: string, target: string, options?: ActionOption): Promise<unknown>
  setInputFiles(
    selector: string,
    files: string | FilePayload | Array<string | FilePayload>,
    options?: ActionOption
  ): Promise<unknown>
  textContent(selector: string, options?: TimeoutOption): Promise<string | null>
  innerText(selector: string, options?: TimeoutOption): Promise<string>
  innerHTML(selector: string, options?: TimeoutOption): Promise<string>
  inputValue(selector: string, options?: TimeoutOption): Promise<string>
  getAttribute(selector: string, name: string, options?: TimeoutOption): Promise<string | null>
  boundingBox(
    selector: string,
    options?: TimeoutOption
  ): Promise<{ x: number; y: number; width: number; height: number } | null>
  getComputedStyle(selector: string, property: string, options?: TimeoutOption): Promise<string>
  allTextContents(selector: string): Promise<string[]>
  allInnerTexts(selector: string): Promise<string[]>
  count(selector: string): Promise<number>
  isVisible(selector: string): Promise<boolean>
  isHidden(selector: string): Promise<boolean>
  isEnabled(selector: string): Promise<boolean>
  isDisabled(selector: string): Promise<boolean>
  isEditable(selector: string): Promise<boolean>
  isChecked(selector: string): Promise<boolean>
  isFocused(selector: string): Promise<boolean>

  installDialogHandler(options?: {
    defaultConfirm?: boolean
    defaultPromptText?: string
  }): Promise<unknown>
  getDialogs(): Promise<
    Array<{
      type: "alert" | "confirm" | "prompt"
      message: string
      default?: string
      timestamp: string
    }>
  >
  clearDialogs(): Promise<unknown>
  route(
    pattern: string,
    response?: {
      status?: number
      body?: string
      contentType?: string
      headers?: Record<string, string>
    }
  ): Promise<unknown>
  unroute(pattern: string): Promise<unknown>
  clearRoutes(): Promise<unknown>
  getNetworkRequests(): Promise<
    Array<{ url: string; method: string; timestamp: string; status?: number; mocked?: boolean }>
  >
  clearNetworkRequests(): Promise<unknown>
  screenshot(options?: { path?: string }): Promise<Buffer>
  startRecording(): never
  stopRecording(): never
  consoleMessages(): Promise<unknown[]>
  networkEvents(): Promise<unknown[]>
  nativeLogs(options?: { lines?: number }): Promise<Array<{ source: string; text: string }>>
  window(label: string): TauriPage
  listWindows(): Promise<WindowInfo[]>
  waitForWindow(
    predicate: (window: WindowInfo) => boolean,
    options?: TimeoutOption
  ): Promise<TauriPage>
  close(): Promise<unknown>
}

export interface TauriAssertions {
  readonly not: TauriAssertions
  toBeVisible(options?: TimeoutOption): Promise<void>
  toBeHidden(options?: TimeoutOption): Promise<void>
  toBeEnabled(options?: TimeoutOption): Promise<void>
  toBeDisabled(options?: TimeoutOption): Promise<void>
  toBeEditable(options?: TimeoutOption): Promise<void>
  toBeChecked(options?: TimeoutOption): Promise<void>
  toBeFocused(options?: TimeoutOption): Promise<void>
  toBeAttached(options?: TimeoutOption): Promise<void>
  toBeEmpty(options?: TimeoutOption): Promise<void>
  toHaveCount(expected: number, options?: TimeoutOption): Promise<void>
  toContainText(expected: TextMatcher, options?: TimeoutOption): Promise<void>
  toHaveText(expected: TextMatcher, options?: TimeoutOption): Promise<void>
  toHaveValue(expected: TextMatcher, options?: TimeoutOption): Promise<void>
  toHaveAttribute(name: string, expected: TextMatcher, options?: TimeoutOption): Promise<void>
  toHaveClass(expected: TextMatcher, options?: TimeoutOption): Promise<void>
  toHaveId(expected: TextMatcher, options?: TimeoutOption): Promise<void>
  toHaveCSS(property: string, expected: TextMatcher, options?: TimeoutOption): Promise<void>
  toHaveURL(expected: TextMatcher, options?: TimeoutOption): Promise<void>
  toHaveTitle(expected: TextMatcher, options?: TimeoutOption): Promise<void>
}

export function tauriExpect(subject: TauriLocator | TauriPage): TauriAssertions
export { tauriExpect as expect }
export function connectTauriPage(options?: TauriPageOptions): TauriPage
