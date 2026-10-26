/**
 * The plugin contract's share of `lib/tray-panel/types.ts`, which re-exports these.
 */
import type { TrayNativeAction } from "../tray/types"

/** Every field kind shares these. `id` is the `{{placeholder}}` name. */
export interface TrayPanelFieldBase {
  /** Stable, unique within an action. Referenced from templates as `{{id}}`. */
  id: string
  /** Already-translated label for custom fields; an i18n key for built-ins. */
  label: string
  labelKey?: string
  /** Blocks the action until the field has a non-empty value. */
  required?: boolean
}

export interface TrayPanelTextField extends TrayPanelFieldBase {
  kind: "text"
  placeholder?: string
  placeholderKey?: string
  defaultValue?: string
  maxLength?: number
}

export interface TrayPanelTextareaField extends TrayPanelFieldBase {
  kind: "textarea"
  placeholder?: string
  placeholderKey?: string
  defaultValue?: string
  maxLength?: number
  rows?: number
  /**
   * Enter submits the panel's primary action instead of inserting a newline
   * (Shift+Enter still breaks the line). True for the delegate composer, which
   * is the surface's whole reason to exist.
   */
  submitOnEnter?: boolean
}

export interface TrayPanelSelectOption {
  value: string
  label: string
  labelKey?: string
}

export interface TrayPanelSelectField extends TrayPanelFieldBase {
  kind: "select"
  options: TrayPanelSelectOption[]
  defaultValue?: string
}

export interface TrayPanelSwitchField extends TrayPanelFieldBase {
  kind: "switch"
  defaultValue?: boolean
}

export interface TrayPanelNumberField extends TrayPanelFieldBase {
  kind: "number"
  min?: number
  max?: number
  step?: number
  defaultValue?: number
}

/** One user-facing input inside an action's form. */
export type TrayPanelField =
  | TrayPanelTextField
  | TrayPanelTextareaField
  | TrayPanelSelectField
  | TrayPanelSwitchField
  | TrayPanelNumberField

/**
 * Which conversation a delegated prompt lands in.
 *
 * `newSession` always starts a fresh one — the safe default for "go do this"
 * work. `activeSession` continues whatever the user last had open (falling
 * back to a new one when there is none), for follow-ups.
 */
export type TrayPanelDelegateTarget = "newSession" | "activeSession"

/**
 * A whole-value reference to a field, e.g. `"{{target}}"`.
 *
 * Non-string effect members accept one of these so a *field* can drive them:
 * that is what makes "custom input box + custom action" more than cosmetic —
 * the built-in delegate action uses it to let a select choose the destination
 * and a switch choose whether to send immediately. Resolution validates the
 * substituted value and fails loudly if it isn't one of the allowed ones.
 */
export type TrayPanelFieldRef = `{{${string}}}`

/**
 * What an action does, as authored. String members may contain `{{fieldId}}`
 * placeholders resolved against the form values — see `template.ts`.
 */
export type TrayPanelEffect =
  | {
      kind: "delegate"
      /** Prompt template. */
      prompt: string
      target: TrayPanelDelegateTarget | TrayPanelFieldRef
      /**
       * Send immediately rather than only staging the text in the composer.
       * Off means "open the app with this typed out", which is the right
       * behaviour for a prompt the user still wants to edit.
       */
      autoSend: boolean | TrayPanelFieldRef
    }
  | { kind: "slash"; command: string }
  | { kind: "command"; commandId: string }
  | { kind: "native"; action: TrayNativeAction }
  | { kind: "navigate"; path: string }

/**
 * How an action fires.
 *
 * - `manual`   — a button in the panel's action list. The default.
 * - `submit`   — the panel's primary action: the big button, and Enter inside
 *                a `submitOnEnter` textarea. At most one action may claim it;
 *                `resolvePrimaryAction` picks the first visible one.
 * - `open`     — runs automatically every time the panel opens. For read-only
 *                effects (navigate/command); a delegate here would fire a turn
 *                the user never asked for, so `validateAction` rejects it.
 * - `hotkey`   — a chord pressed while the panel holds focus, e.g. `mod+1`.
 */
export type TrayPanelTrigger =
  { kind: "manual" } | { kind: "submit" } | { kind: "open" } | { kind: "hotkey"; chord: string }

export interface TrayPanelAction {
  /** Stable id. Built-ins use the `trayPanel.*` prefix. */
  id: string
  /** Already-translated label for custom actions. */
  label: string
  /** i18n key, preferred over `label` when present (built-ins only). */
  labelKey?: string
  description?: string
  descriptionKey?: string
  /** Lucide icon name, resolved by `resolveIcon` (`lib/a2ui/resolve-icon.ts`). */
  icon?: string
  fields: TrayPanelField[]
  effect: TrayPanelEffect
  trigger: TrayPanelTrigger
  /**
   * `when` expression evaluated against the tray state snapshot
   * (`lib/tray/when.ts`). Absent means "always".
   */
  when?: string
  /**
   * Bring the main window forward when this runs. Defaults per effect kind
   * (`defaultFocusForEffect`): delegating or navigating wants the window;
   * firing a plugin command from the tray usually does not.
   */
  focusMainWindow?: boolean
  /** Soft hide that keeps the entry in the user's list. */
  hidden?: boolean
  /**
   * Ships with the app. Built-ins can be hidden, reordered and relabelled but
   * not deleted — `reset()` restores them, and the id is referenced by the
   * default layout.
   */
  builtIn?: boolean
}
