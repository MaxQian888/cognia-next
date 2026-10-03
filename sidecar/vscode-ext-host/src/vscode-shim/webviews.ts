/**
 * `window.createWebviewPanel`, `window.registerWebviewViewProvider` and the
 * `Webview` they carry.
 *
 * The renderer shows each webview as a tab in the app's extension rail, in a
 * sandboxed frame. The extension's HTML is rewritten there so it runs under
 * the app's content security policy: the files it names through
 * `asWebviewUri` are read here (`webview:resource`), from the webview's
 * `localResourceRoots` only (its extension's directory and the workspace
 * folders by default), and inlined; its scripts run as in-frame `blob:`
 * scripts. `cspSource` names what that rewriting produces, so an extension's
 * own `Content-Security-Policy` meta tag keeps working when it uses it.
 *
 * A webview view's provider is resolved when its tab is first shown.
 *
 * Not supported, and documented on the types below: `portMapping` (nothing in
 * a webview reaches the network), `registerWebviewPanelSerializer` restoring
 * panels after a restart (webviews do not outlive the app), `iconPath`, and
 * `enableFindWidget`. Every panel opens in the one rail, so `viewColumn` is
 * the column asked for but places nothing.
 */

import { promises as fs } from "node:fs"
import * as nodePath from "node:path"

import type { RpcConnection } from "../rpc"
import { Disposable, EventEmitter, Uri } from "./types"

/** The authority of the URIs `asWebviewUri` returns. `.invalid` never resolves. */
export const WEBVIEW_RESOURCE_AUTHORITY = "file+.vscode-resource.cognia.invalid"

/**
 * `webview.cspSource`. The renderer inlines resources as `data:` URLs and
 * `<style>` blocks and runs scripts as `blob:` scripts, so those are the
 * sources an extension's policy must allow. `'unsafe-inline'` adds nothing for
 * scripts, which the app's policy never lets run inline.
 */
export const WEBVIEW_CSP_SOURCE = "'unsafe-inline' blob: data:"

/** The largest file a webview may load. */
export const MAX_WEBVIEW_RESOURCE_BYTES = 64 * 1024 * 1024

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".txt": "text/plain",
  ".md": "text/markdown",
}

export function mimeTypeOf(path: string): string {
  return MIME_TYPES[nodePath.extname(path).toLowerCase()] ?? "application/octet-stream"
}

type Event<T> = (
  listener: (value: T) => unknown,
  thisArgs?: unknown,
  disposables?: Array<{ dispose(): unknown }>
) => Disposable

export interface WebviewOptions {
  readonly enableScripts?: boolean
  readonly enableForms?: boolean
  readonly enableCommandUris?: boolean | readonly string[]
  readonly localResourceRoots?: readonly Uri[]
  /** Not supported: nothing in a webview reaches the network. */
  readonly portMapping?: readonly unknown[]
}

export interface WebviewPanelOptions {
  /** Not supported: the frame has no find widget. */
  readonly enableFindWidget?: boolean
  readonly retainContextWhenHidden?: boolean
}

export interface Webview {
  html: string
  options: WebviewOptions
  readonly cspSource: string
  readonly onDidReceiveMessage: Event<unknown>
  postMessage(message: unknown): Thenable<boolean>
  asWebviewUri(localResource: Uri): Uri
}

type Thenable<T> = PromiseLike<T>

/** Where a webview's requests go, and what it may read. */
interface WebviewContext {
  connection: RpcConnection
  extensionId: string
  handle: string
  /** The extension's directory and the workspace folders. */
  defaultRoots: () => string[]
}

function stderr(message: string): void {
  process.stderr.write(`[vscode-shim] ${message}\n`)
}

function wireWebviewOptions(options: WebviewOptions): Record<string, unknown> {
  const commandUris = options.enableCommandUris
  return {
    enableScripts: options.enableScripts === true,
    enableForms: options.enableForms ?? options.enableScripts === true,
    enableCommandUris: Array.isArray(commandUris) ? commandUris.map(String) : commandUris === true,
    ...(options.localResourceRoots
      ? { localResourceRoots: options.localResourceRoots.map((root) => String(root)) }
      : {}),
  }
}

/** The file a webview resource URI names, or `undefined` for anything else. */
export function resourcePathOf(uri: string): string | undefined {
  let parsed: Uri
  try {
    parsed = Uri.parse(uri)
  } catch {
    return undefined
  }
  if (parsed.scheme !== "https" || parsed.authority !== WEBVIEW_RESOURCE_AUTHORITY) return undefined
  return Uri.from({ scheme: "file", path: parsed.path }).fsPath
}

async function realOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await fs.realpath(path)
  } catch {
    return undefined
  }
}

class WebviewImpl implements Webview {
  private currentHtml = ""
  private currentOptions: WebviewOptions
  private readonly messages = new EventEmitter<unknown>()
  readonly cspSource = WEBVIEW_CSP_SOURCE
  readonly onDidReceiveMessage: Event<unknown> = this.messages.event
  disposed = false

  constructor(
    private readonly context: WebviewContext,
    options: WebviewOptions,
    /** Send to the renderer in call order, once the webview exists there. */
    private readonly send: (method: string, params: Record<string, unknown>) => void
  ) {
    this.currentOptions = { ...options }
  }

  get html(): string {
    return this.currentHtml
  }

  set html(value: string) {
    this.currentHtml = String(value)
    this.send("webview:update", { html: this.currentHtml })
  }

  get options(): WebviewOptions {
    return this.currentOptions
  }

  set options(value: WebviewOptions) {
    this.currentOptions = { ...value }
    this.send("webview:update", { options: wireWebviewOptions(this.currentOptions) })
  }

  get wireOptions(): Record<string, unknown> {
    return wireWebviewOptions(this.currentOptions)
  }

  postMessage(message: unknown): Thenable<boolean> {
    if (this.disposed) return Promise.resolve(false)
    return this.context.connection
      .sendRequest<boolean>("webview:postMessage", {
        extensionId: this.context.extensionId,
        handle: this.context.handle,
        message,
      })
      .then(
        (delivered) => delivered === true,
        () => false
      )
  }

  asWebviewUri(resource: Uri): Uri {
    if (resource.scheme !== "file") return resource
    return Uri.from({
      scheme: "https",
      authority: WEBVIEW_RESOURCE_AUTHORITY,
      path: resource.path,
      query: resource.query,
      fragment: resource.fragment,
    })
  }

  receive(message: unknown): void {
    if (!this.disposed) this.messages.fire(message)
  }

  /** The roots a resource must be inside: the webview's own, else the defaults. */
  private roots(): string[] {
    const roots = this.currentOptions.localResourceRoots
    if (!roots) return this.context.defaultRoots()
    return roots
      .map((root) => (root instanceof Uri ? root : Uri.revive(root)))
      .filter((root): root is Uri => root !== undefined && root.scheme === "file")
      .map((root) => root.fsPath)
  }

  /** `webview:resource`: a file under one of the roots, as base64. */
  async readResource(uri: string): Promise<{ data: string; mime: string }> {
    const path = resourcePathOf(uri)
    if (!path) throw new Error(`${uri} is not a webview resource`)
    const real = await realOrUndefined(path)
    if (!real) throw new Error(`${uri} does not exist`)
    let allowed = false
    for (const root of this.roots()) {
      const realRoot = await realOrUndefined(root)
      if (!realRoot) continue
      if (
        real === realRoot ||
        real.startsWith(realRoot.endsWith(nodePath.sep) ? realRoot : `${realRoot}${nodePath.sep}`)
      ) {
        allowed = true
        break
      }
    }
    if (!allowed) throw new Error(`${uri} is outside the webview's localResourceRoots`)
    const stat = await fs.stat(real)
    if (!stat.isFile()) throw new Error(`${uri} is not a file`)
    if (stat.size > MAX_WEBVIEW_RESOURCE_BYTES) {
      throw new Error(`${uri} is larger than ${MAX_WEBVIEW_RESOURCE_BYTES / (1024 * 1024)} MB`)
    }
    return { data: (await fs.readFile(real)).toString("base64"), mime: mimeTypeOf(real) }
  }
}

/** Per-webview request queue: every call waits for the create and keeps its order. */
function createQueue(context: WebviewContext, first: Promise<unknown>) {
  let queue: Promise<unknown> = first.catch(() => undefined)
  let closed = false
  return {
    send(method: string, params: Record<string, unknown>): void {
      if (closed) return
      queue = queue.then(() =>
        context.connection
          .sendRequest(method, {
            extensionId: context.extensionId,
            handle: context.handle,
            ...params,
          })
          .catch((error: unknown) => {
            stderr(
              `${context.extensionId}: ${method} failed: ${error instanceof Error ? error.message : String(error)}`
            )
          })
      )
    },
    close(): void {
      closed = true
    },
  }
}

interface ViewStateOwner {
  readonly extensionId: string
  readonly webview: WebviewImpl
  setViewState(visible: boolean, active: boolean): void
  /** The user (or the app) closed it. */
  closed(): void
}

/** VS Code's `ViewColumn` values that name a real column. */
function columnOf(showOptions: unknown): number {
  const column =
    typeof showOptions === "number"
      ? showOptions
      : showOptions && typeof showOptions === "object"
        ? (showOptions as { viewColumn?: unknown }).viewColumn
        : undefined
  return typeof column === "number" && column > 0 ? column : 1
}

export class WebviewPanel implements ViewStateOwner {
  private currentTitle: string
  private isVisible = true
  private isActive = true
  private isDisposed = false
  private readonly disposeEmitter = new EventEmitter<void>()
  private readonly stateEmitter = new EventEmitter<{ webviewPanel: WebviewPanel }>()
  readonly webview: WebviewImpl
  readonly options: WebviewPanelOptions
  readonly viewColumn: number
  /** Not supported: the rail's tabs show no icons. */
  iconPath: unknown = undefined
  readonly onDidDispose: Event<void> = this.disposeEmitter.event
  readonly onDidChangeViewState: Event<{ webviewPanel: WebviewPanel }> = this.stateEmitter.event

  constructor(
    private readonly registry: WebviewRegistry,
    private readonly context: WebviewContext,
    readonly viewType: string,
    title: string,
    showOptions: unknown,
    options: WebviewPanelOptions & WebviewOptions
  ) {
    this.currentTitle = String(title)
    this.viewColumn = columnOf(showOptions)
    this.options = {
      enableFindWidget: options.enableFindWidget,
      retainContextWhenHidden: options.retainContextWhenHidden === true,
    }
    const created = context.connection.sendRequest("window:createWebviewPanel", {
      extensionId: context.extensionId,
      handle: context.handle,
      viewType,
      title: this.currentTitle,
      preserveFocus:
        typeof showOptions === "object" && showOptions !== null
          ? (showOptions as { preserveFocus?: unknown }).preserveFocus === true
          : false,
      options: {
        ...wireWebviewOptions(options),
        retainContextWhenHidden: this.options.retainContextWhenHidden,
      },
    })
    created.catch((error: unknown) => {
      stderr(
        `${context.extensionId}: webview panel "${this.currentTitle}" was not shown: ${error instanceof Error ? error.message : String(error)}`
      )
      this.closed()
    })
    this.queue = createQueue(context, created)
    this.webview = new WebviewImpl(context, options, (method, params) =>
      this.queue.send(method, params)
    )
    registry.add(context.handle, this)
  }

  private readonly queue: ReturnType<typeof createQueue>

  get extensionId(): string {
    return this.context.extensionId
  }

  get title(): string {
    return this.currentTitle
  }

  set title(value: string) {
    this.currentTitle = String(value)
    this.queue.send("webview:update", { title: this.currentTitle })
  }

  get visible(): boolean {
    return this.isVisible
  }

  get active(): boolean {
    return this.isActive
  }

  reveal(_viewColumn?: number, preserveFocus?: boolean): void {
    if (this.isDisposed) return
    this.queue.send("webview:reveal", { preserveFocus: preserveFocus === true })
  }

  dispose(): void {
    if (this.isDisposed) return
    this.queue.send("webview:dispose", {})
    this.closed()
  }

  setViewState(visible: boolean, active: boolean): void {
    if (this.isDisposed || (visible === this.isVisible && active === this.isActive)) return
    this.isVisible = visible
    this.isActive = active
    this.stateEmitter.fire({ webviewPanel: this })
  }

  closed(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.webview.disposed = true
    this.isVisible = false
    this.isActive = false
    this.queue.close()
    this.registry.remove(this.context.handle)
    this.disposeEmitter.fire(undefined)
  }
}

export class WebviewView implements ViewStateOwner {
  private currentTitle: string | undefined
  private currentDescription: string | undefined
  private currentBadge: { value: number; tooltip: string } | undefined
  private isVisible = true
  private isDisposed = false
  private readonly disposeEmitter = new EventEmitter<void>()
  private readonly visibilityEmitter = new EventEmitter<void>()
  private readonly queue: ReturnType<typeof createQueue>
  readonly webview: WebviewImpl
  readonly onDidDispose: Event<void> = this.disposeEmitter.event
  readonly onDidChangeVisibility: Event<void> = this.visibilityEmitter.event

  constructor(
    private readonly registry: WebviewRegistry,
    private readonly context: WebviewContext,
    readonly viewType: string,
    title: string | undefined
  ) {
    this.currentTitle = title
    // The renderer created the view's tab before asking for it.
    this.queue = createQueue(context, Promise.resolve())
    this.webview = new WebviewImpl(context, {}, (method, params) => this.queue.send(method, params))
    registry.add(context.handle, this)
  }

  get extensionId(): string {
    return this.context.extensionId
  }

  get title(): string | undefined {
    return this.currentTitle
  }

  set title(value: string | undefined) {
    this.currentTitle = value
    this.queue.send("webview:update", { title: value ?? null })
  }

  get description(): string | undefined {
    return this.currentDescription
  }

  set description(value: string | undefined) {
    this.currentDescription = value
    this.queue.send("webview:update", { description: value ?? null })
  }

  get badge(): { value: number; tooltip: string } | undefined {
    return this.currentBadge
  }

  set badge(value: { value: number; tooltip: string } | undefined) {
    this.currentBadge = value
      ? { value: Number(value.value), tooltip: String(value.tooltip ?? "") }
      : undefined
    this.queue.send("webview:update", { badge: this.currentBadge ?? null })
  }

  get visible(): boolean {
    return this.isVisible
  }

  show(preserveFocus?: boolean): void {
    if (this.isDisposed) return
    this.queue.send("webview:reveal", { preserveFocus: preserveFocus === true })
  }

  setViewState(visible: boolean): void {
    if (this.isDisposed || visible === this.isVisible) return
    this.isVisible = visible
    this.visibilityEmitter.fire(undefined)
  }

  closed(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.webview.disposed = true
    this.isVisible = false
    this.queue.close()
    this.registry.remove(this.context.handle)
    this.disposeEmitter.fire(undefined)
  }
}

/**
 * The host's webviews by handle, for the renderer's reports: a message from
 * the frame, a change of visibility, the user closing one, a resource read.
 */
export class WebviewRegistry {
  private readonly webviews = new Map<string, ViewStateOwner>()
  private sequence = 0

  attach(connection: RpcConnection): void {
    const find = (params: unknown) => {
      const handle = (params as { handle?: unknown }).handle
      return typeof handle === "string" ? this.webviews.get(handle) : undefined
    }
    connection.onRequest("webview:message", (params) => {
      find(params)?.webview.receive((params as { message?: unknown }).message)
      return null
    })
    connection.onRequest("webview:viewState", (params) => {
      const { visible, active } = params as { visible?: unknown; active?: unknown }
      find(params)?.setViewState(visible === true, active === true)
      return null
    })
    connection.onRequest("webview:disposed", (params) => {
      find(params)?.closed()
      return null
    })
    connection.onRequest("webview:resource", async (params) => {
      const owner = find(params)
      if (!owner) throw new Error("The webview is gone")
      return owner.webview.readResource(String((params as { uri?: unknown }).uri ?? ""))
    })
  }

  nextHandle(extensionId: string): string {
    this.sequence += 1
    return `webview:${extensionId}:${this.sequence}`
  }

  add(handle: string, owner: ViewStateOwner): void {
    this.webviews.set(handle, owner)
  }

  remove(handle: string): void {
    this.webviews.delete(handle)
  }

  /** The views a provider resolved for `viewType`. */
  viewsOf(extensionId: string, viewType: string): WebviewView[] {
    return [...this.webviews.values()].filter(
      (owner): owner is WebviewView =>
        owner instanceof WebviewView &&
        owner.extensionId === extensionId &&
        owner.viewType === viewType
    )
  }

  /** The extension stopped: its webviews close with it. */
  closeAll(extensionId: string): void {
    for (const owner of [...this.webviews.values()]) {
      if (owner.extensionId === extensionId) owner.closed()
    }
  }
}

/** A contributed view's name from `package.json`, `%key%` resolved from `package.nls.json`. */
async function contributedViewName(
  extensionPath: string,
  viewId: string
): Promise<string | undefined> {
  const read = async (file: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const value: unknown = JSON.parse(
        await fs.readFile(nodePath.join(extensionPath, file), "utf-8")
      )
      return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  const pkg = await read("package.json")
  const views = (pkg?.contributes as { views?: Record<string, unknown> } | undefined)?.views
  if (!views || typeof views !== "object") return undefined
  for (const list of Object.values(views)) {
    if (!Array.isArray(list)) continue
    const view = list.find((entry) => (entry as { id?: unknown })?.id === viewId) as
      { name?: unknown } | undefined
    if (typeof view?.name !== "string") continue
    const key = /^%(.+)%$/.exec(view.name)?.[1]
    if (!key) return view.name
    const nls = await read("package.nls.json")
    const text = nls?.[key]
    return typeof text === "string"
      ? text
      : ((text as { message?: unknown } | undefined)?.message as string | undefined)
  }
  return undefined
}

/** The `window` members about webviews, for one extension. */
export function createWebviewWindowMembers(input: {
  registry: WebviewRegistry
  connection: RpcConnection
  extensionId: string
  extensionPath: () => string | undefined
  defaultRoots: () => string[]
  registerProviderCallback: (
    token: string,
    cb: (payload: unknown, call: { cancellation: unknown }) => Promise<unknown> | unknown
  ) => () => void
}) {
  const { registry, connection, extensionId } = input
  const context = (handle: string): WebviewContext => ({
    connection,
    extensionId,
    handle,
    defaultRoots: input.defaultRoots,
  })
  const registeredViews = new Set<string>()
  return {
    createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: unknown,
      options: WebviewPanelOptions & WebviewOptions = {}
    ): WebviewPanel {
      return new WebviewPanel(
        registry,
        context(registry.nextHandle(extensionId)),
        String(viewType),
        title,
        showOptions,
        options ?? {}
      )
    },

    registerWebviewViewProvider(
      viewId: string,
      provider: {
        resolveWebviewView(
          view: WebviewView,
          context: { state: unknown },
          token: unknown
        ): void | Thenable<void>
      },
      options?: { webviewOptions?: { retainContextWhenHidden?: boolean } }
    ): Disposable {
      if (registeredViews.has(viewId)) {
        throw new Error(`A webview view provider is already registered for ${viewId}`)
      }
      registeredViews.add(viewId)
      const token = `wvv:${extensionId}:${viewId}`
      const unregisterCallback = input.registerProviderCallback(token, async (payload, call) => {
        const { handle, title, state } = (payload ?? {}) as {
          handle?: unknown
          title?: unknown
          state?: unknown
        }
        if (typeof handle !== "string") throw new Error("resolveWebviewView needs a handle")
        const view = new WebviewView(
          registry,
          context(handle),
          viewId,
          typeof title === "string" ? title : undefined
        )
        try {
          await provider.resolveWebviewView(view, { state }, call.cancellation)
        } catch (error) {
          stderr(
            `${extensionId}: resolveWebviewView for ${viewId} threw: ${error instanceof Error ? error.message : String(error)}`
          )
        }
        return null
      })
      void (async () => {
        const path = input.extensionPath()
        const title = (path ? await contributedViewName(path, viewId) : undefined) ?? viewId
        await connection.sendRequest("window:registerWebviewViewProvider", {
          extensionId,
          viewId,
          token,
          title,
          retainContextWhenHidden: options?.webviewOptions?.retainContextWhenHidden === true,
        })
      })().catch((error: unknown) => {
        stderr(
          `${extensionId}: webview view ${viewId} was not registered: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      let disposed = false
      return new Disposable(() => {
        if (disposed) return
        disposed = true
        registeredViews.delete(viewId)
        unregisterCallback()
        for (const view of registry.viewsOf(extensionId, viewId)) view.closed()
        void connection
          .sendRequest("window:unregisterWebviewViewProvider", { extensionId, viewId })
          .catch(() => undefined)
      })
    },

    /** Not supported: webviews do not outlive the app, so there is nothing to restore. */
    registerWebviewPanelSerializer(_viewType: string, _serializer: unknown): Disposable {
      return new Disposable(() => undefined)
    },
  }
}
