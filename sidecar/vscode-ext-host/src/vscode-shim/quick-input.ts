/**
 * `window.createQuickPick` / `createInputBox`, and `showQuickPick` /
 * `showInputBox` built on them the way VS Code builds them.
 *
 * A quick input is live: the extension changes its items, value, busy flag
 * and so on while it is open, and hears the user typing, moving, selecting,
 * accepting and dismissing. The renderer draws it (`vscode-quick-input` in
 * `components/plugins/vscode/`) from the state sent here:
 *
 *   - `window:quickInputOpen {extensionId, sessionId, kind, state}` on `show()`;
 *   - `window:quickInputUpdate {sessionId, state}` with the fields that changed,
 *     coalesced per tick;
 *   - `window:quickInputClose {sessionId}` on `hide()` / `dispose()`.
 *
 * The renderer reports what the user did with `window:quickInputEvent
 * {sessionId, event}`; items travel as indices into the last items sent, so
 * the extension gets its own item objects back.
 */

import type { RpcConnection } from "../rpc"
import { InputBoxValidationSeverity, QuickPickItemKind } from "./api-types"
import { EventEmitter, type CancellationToken } from "./types"

export interface QuickInputButton {
  iconPath: unknown
  tooltip?: string
}

export interface QuickPickItem {
  label: string
  kind?: number
  description?: string
  detail?: string
  picked?: boolean
  alwaysShow?: boolean
  iconPath?: unknown
  buttons?: readonly QuickInputButton[]
}

type QuickInputEvent =
  | { type: "value"; value: string }
  | { type: "active"; indices: number[] }
  | { type: "selection"; indices: number[] }
  | { type: "accept"; selected?: number[] }
  | { type: "hide" }
  | { type: "button"; index: number }
  | { type: "itemButton"; item: number; button: number }

interface Session {
  handle(event: QuickInputEvent): void
}

const sessionsByConnection = new WeakMap<RpcConnection, Map<string, Session>>()

/** One handler per connection routes renderer events to the session they are for. */
function sessionsFor(connection: RpcConnection): Map<string, Session> {
  let sessions = sessionsByConnection.get(connection)
  if (!sessions) {
    sessions = new Map()
    sessionsByConnection.set(connection, sessions)
    const routed = sessions
    connection.onRequest("window:quickInputEvent", (params) => {
      const { sessionId, event } = params as { sessionId: string; event: QuickInputEvent }
      routed.get(sessionId)?.handle(event)
      return null
    })
  }
  return sessions
}

/** A `ThemeIcon` keeps its id; any other icon (a path or `{light, dark}`) has no codicon. */
function wireIcon(icon: unknown): string | undefined {
  return typeof icon === "object" &&
    icon !== null &&
    typeof (icon as { id?: unknown }).id === "string"
    ? (icon as { id: string }).id
    : undefined
}

function wireButtons(buttons: readonly QuickInputButton[]) {
  return buttons.map((button) => ({
    ...(wireIcon(button.iconPath) ? { icon: wireIcon(button.iconPath) } : {}),
    ...(button.tooltip ? { tooltip: button.tooltip } : {}),
  }))
}

let nextSession = 0

abstract class QuickInputBase {
  readonly sessionId: string
  protected visible = false
  private disposed = false
  private pending: Record<string, unknown> = {}
  /** Fields whose changes are sent to the renderer. */
  private readonly watched: string[] = []
  private flushQueued = false
  protected buttonList: readonly QuickInputButton[] = []

  readonly hideEmitter = new EventEmitter<void>()
  readonly acceptEmitter = new EventEmitter<void>()
  readonly valueEmitter = new EventEmitter<string>()
  readonly buttonEmitter = new EventEmitter<QuickInputButton>()

  title: string | undefined
  step: number | undefined
  totalSteps: number | undefined
  enabled = true
  busy = false
  ignoreFocusOut = false
  value = ""
  placeholder: string | undefined

  readonly onDidHide = this.hideEmitter.event
  readonly onDidAccept = this.acceptEmitter.event
  readonly onDidChangeValue = this.valueEmitter.event
  readonly onDidTriggerButton = this.buttonEmitter.event

  protected constructor(
    protected readonly connection: RpcConnection,
    protected readonly extensionId: string,
    private readonly kind: "pick" | "input"
  ) {
    nextSession += 1
    this.sessionId = `qi:${extensionId}:${nextSession}`
    sessionsFor(connection).set(this.sessionId, {
      handle: (event) => this.handle(event),
    })
    this.watch([
      "title",
      "step",
      "totalSteps",
      "enabled",
      "busy",
      "ignoreFocusOut",
      "value",
      "placeholder",
    ])
  }

  /**
   * Turn `fields` into accessors that report changes. Each class calls this
   * at the end of its own constructor, once its field initializers have run;
   * installing them earlier would let those initializers replace them.
   */
  protected watch(fields: string[]): void {
    for (const field of fields) {
      let current = (this as Record<string, unknown>)[field]
      Object.defineProperty(this, field, {
        get: () => current,
        set: (value: unknown) => {
          current = value
          this.changed(field)
        },
        enumerable: true,
        configurable: true,
      })
      this.watched.push(field)
    }
  }

  get buttons(): readonly QuickInputButton[] {
    return this.buttonList
  }
  set buttons(value: readonly QuickInputButton[]) {
    this.buttonList = value
    this.changed("buttons")
  }

  /** The renderer's form of `field`. */
  protected wireField(field: string): unknown {
    if (field === "buttons") return wireButtons(this.buttonList)
    return (this as Record<string, unknown>)[field]
  }

  protected fullState(): Record<string, unknown> {
    const state: Record<string, unknown> = { buttons: this.wireField("buttons") }
    for (const field of this.watched) state[field] = this.wireField(field)
    return state
  }

  protected changed(field: string): void {
    if (!this.visible || this.disposed) return
    this.pending[field] = this.wireField(field)
    if (this.flushQueued) return
    this.flushQueued = true
    queueMicrotask(() => {
      this.flushQueued = false
      if (!this.visible || Object.keys(this.pending).length === 0) return
      const state = this.pending
      this.pending = {}
      void this.connection.sendNotification("window:quickInputUpdate", {
        sessionId: this.sessionId,
        state,
      })
    })
  }

  show(): void {
    if (this.visible || this.disposed) return
    this.visible = true
    this.pending = {}
    this.connection
      .sendRequest("window:quickInputOpen", {
        extensionId: this.extensionId,
        sessionId: this.sessionId,
        kind: this.kind,
        state: this.fullState(),
      })
      .catch(() => {
        // The renderer could not show it; to the extension that is a dismissal.
        this.closed()
      })
  }

  hide(): void {
    if (!this.visible) return
    void this.connection.sendNotification("window:quickInputClose", { sessionId: this.sessionId })
    this.closed()
  }

  dispose(): void {
    if (this.disposed) return
    this.hide()
    this.disposed = true
    sessionsFor(this.connection).delete(this.sessionId)
    for (const emitter of [
      this.hideEmitter,
      this.acceptEmitter,
      this.valueEmitter,
      this.buttonEmitter,
    ]) {
      emitter.dispose()
    }
    this.disposeEmitters()
  }

  protected disposeEmitters(): void {}

  private closed(): void {
    if (!this.visible) return
    this.visible = false
    this.hideEmitter.fire(undefined)
  }

  protected handle(event: QuickInputEvent): void {
    switch (event.type) {
      case "value":
        this.setFromUser("value", event.value)
        this.valueEmitter.fire(event.value)
        break
      case "hide":
        this.closed()
        break
      case "button": {
        const button = this.buttonList[event.index]
        if (button) this.buttonEmitter.fire(button)
        break
      }
      default:
        this.handleKind(event)
    }
  }

  protected abstract handleKind(event: QuickInputEvent): void

  /** Take a value the user produced without echoing it back to the renderer. */
  protected setFromUser(field: string, value: unknown): void {
    const visible = this.visible
    this.visible = false
    ;(this as Record<string, unknown>)[field] = value
    this.visible = visible
  }
}

export class QuickPick<T extends QuickPickItem> extends QuickInputBase {
  private itemList: readonly T[] = []
  private active: readonly T[] = []
  private selected: readonly T[] = []
  canSelectMany = false
  matchOnDescription = false
  matchOnDetail = false
  keepScrollPosition = false
  sortByLabel = true

  private readonly activeEmitter = new EventEmitter<readonly T[]>()
  private readonly selectionEmitter = new EventEmitter<readonly T[]>()
  private readonly itemButtonEmitter = new EventEmitter<{ button: QuickInputButton; item: T }>()
  readonly onDidChangeActive = this.activeEmitter.event
  readonly onDidChangeSelection = this.selectionEmitter.event
  readonly onDidTriggerItemButton = this.itemButtonEmitter.event

  constructor(connection: RpcConnection, extensionId: string) {
    super(connection, extensionId, "pick")
    this.watch([
      "canSelectMany",
      "matchOnDescription",
      "matchOnDetail",
      "keepScrollPosition",
      "sortByLabel",
    ])
  }

  get items(): readonly T[] {
    return this.itemList
  }
  set items(value: readonly T[]) {
    this.itemList = value
    // Active and selected items must be items of the list.
    this.active = this.active.filter((item) => value.includes(item))
    this.selected = this.selected.filter((item) => value.includes(item))
    this.changed("items")
    this.changed("activeIndices")
    this.changed("selectedIndices")
  }

  get activeItems(): readonly T[] {
    return this.active
  }
  set activeItems(value: readonly T[]) {
    this.active = value.filter((item) => this.itemList.includes(item))
    this.changed("activeIndices")
  }

  get selectedItems(): readonly T[] {
    return this.selected
  }
  set selectedItems(value: readonly T[]) {
    this.selected = value.filter((item) => this.itemList.includes(item))
    this.changed("selectedIndices")
  }

  protected wireField(field: string): unknown {
    switch (field) {
      case "items":
        return this.itemList.map((item) => ({
          label: item.label,
          ...(item.kind === QuickPickItemKind.Separator ? { separator: true } : {}),
          ...(item.description ? { description: item.description } : {}),
          ...(item.detail ? { detail: item.detail } : {}),
          ...(item.alwaysShow ? { alwaysShow: true } : {}),
          ...(wireIcon(item.iconPath) ? { icon: wireIcon(item.iconPath) } : {}),
          ...(item.buttons?.length ? { buttons: wireButtons(item.buttons) } : {}),
        }))
      case "activeIndices":
        return this.active.map((item) => this.itemList.indexOf(item))
      case "selectedIndices":
        return this.selected.map((item) => this.itemList.indexOf(item))
      default:
        return super.wireField(field)
    }
  }

  protected fullState(): Record<string, unknown> {
    return {
      ...super.fullState(),
      items: this.wireField("items"),
      activeIndices: this.wireField("activeIndices"),
      selectedIndices: this.wireField("selectedIndices"),
    }
  }

  private itemsAt(indices: number[]): T[] {
    return indices
      .map((index) => this.itemList[index])
      .filter((item): item is T => item !== undefined && item.kind !== QuickPickItemKind.Separator)
  }

  protected handleKind(event: QuickInputEvent): void {
    switch (event.type) {
      case "active":
        this.active = this.itemsAt(event.indices)
        this.activeEmitter.fire(this.active)
        break
      case "selection":
        this.selected = this.itemsAt(event.indices)
        this.selectionEmitter.fire(this.selected)
        break
      case "accept":
        if (event.selected) {
          this.selected = this.itemsAt(event.selected)
          this.selectionEmitter.fire(this.selected)
        }
        this.acceptEmitter.fire(undefined)
        break
      case "itemButton": {
        const item = this.itemList[event.item]
        const button = item?.buttons?.[event.button]
        if (item && button) this.itemButtonEmitter.fire({ button, item })
        break
      }
    }
  }

  protected disposeEmitters(): void {
    this.activeEmitter.dispose()
    this.selectionEmitter.dispose()
    this.itemButtonEmitter.dispose()
  }
}

export type ValidationMessage = string | { message: string; severity: number } | undefined

export class InputBox extends QuickInputBase {
  valueSelection: readonly [number, number] | undefined
  password = false
  prompt: string | undefined
  validationMessage: ValidationMessage

  constructor(connection: RpcConnection, extensionId: string) {
    super(connection, extensionId, "input")
    this.watch(["valueSelection", "password", "prompt", "validationMessage"])
  }

  protected wireField(field: string): unknown {
    if (field === "validationMessage") {
      const message = this.validationMessage
      if (message === undefined || message === "") return undefined
      return typeof message === "string"
        ? { message, severity: InputBoxValidationSeverity.Error }
        : message
    }
    return super.wireField(field)
  }

  protected handleKind(event: QuickInputEvent): void {
    if (event.type === "accept") this.acceptEmitter.fire(undefined)
  }
}

function blocksAccept(message: ValidationMessage): boolean {
  if (message === undefined || message === "") return false
  return typeof message === "string" || message.severity === InputBoxValidationSeverity.Error
}

export interface QuickPickOptions {
  title?: string
  placeHolder?: string
  canPickMany?: boolean
  matchOnDescription?: boolean
  matchOnDetail?: boolean
  ignoreFocusOut?: boolean
  onDidSelectItem?: (item: QuickPickItem | string) => unknown
}

/** `window.showQuickPick`: strings or items, one or many; `undefined` when dismissed. */
export async function showQuickPick(
  connection: RpcConnection,
  extensionId: string,
  itemsOrPromise:
    readonly (string | QuickPickItem)[] | Thenable<readonly (string | QuickPickItem)[]>,
  options: QuickPickOptions = {},
  token?: CancellationToken
): Promise<unknown> {
  const picker = new QuickPick<QuickPickItem>(connection, extensionId)
  picker.title = options.title
  picker.placeholder = options.placeHolder
  picker.canSelectMany = options.canPickMany ?? false
  picker.matchOnDescription = options.matchOnDescription ?? false
  picker.matchOnDetail = options.matchOnDetail ?? false
  picker.ignoreFocusOut = options.ignoreFocusOut ?? false
  // Like VS Code: show at once, busy until the items arrive.
  picker.busy = true
  picker.show()
  const originals = await Promise.resolve(itemsOrPromise)
  const items = originals.map((entry) => (typeof entry === "string" ? { label: entry } : entry))
  const original = (item: QuickPickItem) => originals[items.indexOf(item)]
  picker.items = items
  if (picker.canSelectMany) picker.selectedItems = items.filter((item) => item.picked)
  picker.busy = false

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: unknown) => {
      if (settled) return
      settled = true
      resolve(value)
      picker.dispose()
    }
    picker.onDidAccept(() => {
      if (picker.canSelectMany) {
        finish(picker.selectedItems.map(original))
      } else {
        const chosen = picker.selectedItems[0] ?? picker.activeItems[0]
        finish(chosen ? original(chosen) : undefined)
      }
    })
    picker.onDidHide(() => finish(undefined))
    if (options.onDidSelectItem) {
      picker.onDidChangeActive((active) => {
        if (active[0]) void options.onDidSelectItem?.(original(active[0]))
      })
    }
    token?.onCancellationRequested(() => picker.hide())
    if (token?.isCancellationRequested) picker.hide()
  })
}

export interface InputBoxOptions {
  title?: string
  value?: string
  valueSelection?: [number, number]
  prompt?: string
  placeHolder?: string
  password?: boolean
  ignoreFocusOut?: boolean
  validateInput?: (value: string) => ValidationMessage | null | Thenable<ValidationMessage | null>
}

/** `window.showInputBox`: the accepted value, or `undefined` when dismissed. */
export function showInputBox(
  connection: RpcConnection,
  extensionId: string,
  options: InputBoxOptions = {},
  token?: CancellationToken
): Promise<string | undefined> {
  const input = new InputBox(connection, extensionId)
  input.title = options.title
  input.value = options.value ?? ""
  input.valueSelection = options.valueSelection
  input.prompt = options.prompt
  input.placeholder = options.placeHolder
  input.password = options.password ?? false
  input.ignoreFocusOut = options.ignoreFocusOut ?? false

  let validation = 0
  /** Run the extension's validator; a later run supersedes an earlier one. */
  const validate = async (value: string): Promise<ValidationMessage> => {
    if (!options.validateInput) return undefined
    validation += 1
    const run = validation
    input.busy = true
    try {
      const message = (await options.validateInput(value)) ?? undefined
      if (run === validation) input.validationMessage = message
      return message
    } finally {
      if (run === validation) input.busy = false
    }
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
      input.dispose()
    }
    input.onDidChangeValue((value) => void validate(value))
    input.onDidAccept(async () => {
      const message = await validate(input.value)
      if (!blocksAccept(message)) finish(input.value)
    })
    input.onDidHide(() => finish(undefined))
    token?.onCancellationRequested(() => input.hide())
    input.show()
    if (token?.isCancellationRequested) input.hide()
    void validate(input.value)
  })
}
