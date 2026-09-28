/**
 * The preview's "Export" control: a small state machine plus the toolbar DOM
 * it renders. The preview re-renders its whole tree on every artifact update
 * or locale switch, so the state lives in a controller owned by the mount and
 * the toolbar is rebuilt from it each time.
 *
 * The runtime's export refuses a workbook with validation errors and asks for
 * confirmation before dropping unsupported imported features; the control
 * shows both outcomes instead of the model-facing English sentence.
 */

/** The fields of a runtime export result the control reads. */
export interface ExportOutcomeLike {
  ok: boolean
  saved?: boolean
  cancelled?: boolean
  filename?: string
  requiresConfirmation?: boolean
  unsupportedFeatures?: readonly string[]
  findings?: ReadonlyArray<{ severity: string }>
  /** Why a save was refused, when the runtime can say so in a locale-neutral way. */
  reason?: "invalid-package"
  error?: string
}

export type ExportState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "confirm"; count: number }
  | { phase: "saved"; filename: string }
  | { phase: "cancelled" }
  | { phase: "blocked" }
  | { phase: "invalid" }
  | { phase: "failed"; error: string }

export type ExportTranslator = (key: string, params?: Record<string, string | number>) => string

export interface ExportController {
  readonly state: ExportState
  /** Run the export; `allowLoss` confirms dropping unsupported features. */
  start: (allowLoss: boolean) => void
  /** Leave the confirmation prompt without exporting. */
  dismiss: () => void
}

export function createExportController(options: {
  run: (allowLoss: boolean) => Promise<ExportOutcomeLike>
  onChange: () => void
  isDisposed: () => boolean
}): ExportController {
  let state: ExportState = { phase: "idle" }
  const set = (next: ExportState) => {
    state = next
    if (!options.isDisposed()) options.onChange()
  }
  return {
    get state() {
      return state
    },
    start: (allowLoss) => {
      // One save at a time: a second click would open a second dialog.
      if (state.phase === "working") return
      set({ phase: "working" })
      Promise.resolve()
        .then(() => options.run(allowLoss))
        .then(
          (outcome) => set(classifyOutcome(outcome)),
          (error: unknown) =>
            set({ phase: "failed", error: error instanceof Error ? error.message : String(error) })
        )
    },
    dismiss: () => {
      if (state.phase === "confirm") set({ phase: "idle" })
    },
  }
}

export function classifyOutcome(outcome: ExportOutcomeLike): ExportState {
  if (outcome.requiresConfirmation)
    return { phase: "confirm", count: outcome.unsupportedFeatures?.length ?? 0 }
  if (outcome.saved && outcome.filename) return { phase: "saved", filename: outcome.filename }
  if (outcome.cancelled) return { phase: "cancelled" }
  if (outcome.findings?.some((finding) => finding.severity === "error")) return { phase: "blocked" }
  if (outcome.reason === "invalid-package") return { phase: "invalid" }
  return { phase: "failed", error: outcome.error ?? "" }
}

/**
 * The toolbar: the export button, a polite status line, and — while
 * confirming — "export anyway" / "cancel". Buttons carry `data-focus-key` so
 * the preview can put keyboard focus back after its re-render.
 */
export function renderExportBar(
  controller: ExportController,
  t: ExportTranslator,
  classPrefix: string
): HTMLElement {
  const state = controller.state
  const bar = document.createElement("div")
  bar.className = `${classPrefix}-toolbar`
  bar.setAttribute("role", "toolbar")
  bar.setAttribute("aria-label", t("export.toolbar"))

  const working = state.phase === "working"
  if (state.phase === "confirm") {
    bar.append(
      button(t("export.confirmAction"), "export:confirm", classPrefix, false, () =>
        controller.start(true)
      ),
      button(t("export.dismiss"), "export:dismiss", classPrefix, false, () => controller.dismiss())
    )
  } else {
    bar.append(
      button(t("export.button"), "export:run", classPrefix, working, () => controller.start(false))
    )
  }

  const status = document.createElement("p")
  status.className = `${classPrefix}-export-status`
  const failed = state.phase === "failed" || state.phase === "blocked" || state.phase === "invalid"
  status.setAttribute("role", failed ? "alert" : "status")
  status.dataset.phase = state.phase
  status.textContent = statusText(state, t)
  bar.appendChild(status)
  return bar
}

function statusText(state: ExportState, t: ExportTranslator): string {
  switch (state.phase) {
    case "idle":
      return ""
    case "working":
      return t("export.working")
    case "confirm":
      return t("export.confirm", { count: state.count })
    case "saved":
      return t("export.saved", { filename: state.filename })
    case "cancelled":
      return t("export.cancelled")
    case "blocked":
      return t("export.blocked")
    case "invalid":
      return t("export.invalid")
    case "failed":
      return state.error ? t("export.failed", { error: state.error }) : t("export.failedUnknown")
  }
}

/**
 * `aria-disabled` rather than `disabled` while a save runs, so keyboard focus
 * stays on the button through the re-render.
 */
function button(
  label: string,
  focusKey: string,
  classPrefix: string,
  locked: boolean,
  onClick: () => void
): HTMLButtonElement {
  const element = document.createElement("button")
  element.type = "button"
  element.className = `${classPrefix}-btn`
  element.textContent = label
  element.dataset.focusKey = focusKey
  if (locked) element.setAttribute("aria-disabled", "true")
  element.addEventListener("click", () => {
    if (element.getAttribute("aria-disabled") === "true") return
    onClick()
  })
  return element
}
