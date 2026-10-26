"use client"

/**
 * Promise-returning replacements for `window.confirm` / `window.prompt`, drawn
 * with the app's AlertDialog and Dialog + Select instead of a browser-owned box.
 *
 *   const { confirm, dialog } = useConfirmDialog()
 *   if (!(await confirm({ title, description, destructive: true }))) return
 *   …
 *   return <>{…}{dialog}</>
 *
 * Use these where the decision sits in the middle of an async flow (an approval
 * callback, a step inside a biometric guard, a second confirmation). A button
 * that only opens one fixed confirmation can compose AlertDialog directly.
 *
 * Contract both hooks keep:
 *
 *  - **Requests queue.** Each call is answered on its own, in order; a second
 *    request never cancels or reuses the first one's answer, so an approval
 *    stays attributed to the request that asked for it.
 *  - **Dismissal means no.** Cancel, Escape and unmount resolve `false` / `null`.
 *    A call made after unmount resolves the negative answer at once.
 *  - **Focus returns** to the element that was focused when the request was
 *    made (or `restoreFocus()`'s target), because a dialog opened without a
 *    Trigger has nothing for Radix to return focus to.
 *  - **`confirm` / `choose` are stable**, so callers can pass them into effect
 *    dependencies (an MCP app bridge reconnects whenever its callbacks change).
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface BaseDialogOptions {
  title: ReactNode
  description?: ReactNode
  /** Extra body under the description (a list of changes, a warning). */
  details?: ReactNode
  /** Defaults to `common.confirm`. */
  confirmLabel?: ReactNode
  /** Defaults to `common.cancel`. */
  cancelLabel?: ReactNode
  /** Destructive styling on the confirm action. */
  destructive?: boolean
  /** Element to focus once the dialog closes. Defaults to the one focused before it opened. */
  restoreFocus?: () => HTMLElement | null | undefined
  /** `data-testid` of the content box; the actions get `-confirm` / `-cancel` suffixes. */
  testid?: string
}

export type ConfirmDialogOptions = BaseDialogOptions

export interface ChoiceDialogOption {
  value: string
  label: ReactNode
  /** Secondary line under the label, e.g. an id or a last-seen time. */
  description?: ReactNode
}

export interface ChoiceDialogOptions extends BaseDialogOptions {
  /** Non-empty list of valid answers. Nothing outside it can be returned. */
  options: ChoiceDialogOption[]
  /** Visible label of the select field. */
  fieldLabel: ReactNode
  /** Preselected value; defaults to the first option. */
  defaultValue?: string
}

interface QueueEntry<TOptions, TResult> {
  options: TOptions
  resolve: (value: TResult) => void
}

/**
 * FIFO of pending requests. The head is on screen; `settle` answers it and
 * shows the next. `lastShown` keeps the previous head's content mounted while
 * the dialog animates out, so the box does not flash empty.
 *
 * Focus is tracked per "session" (queue empty → non-empty → empty): the element
 * focused when the first request arrived gets focus back on the final close. A
 * request that arrives while the box is still closing (a second confirmation
 * right after the first) joins the same session instead of capturing the
 * closing dialog's own button.
 */
function usePromiseQueue<TOptions extends BaseDialogOptions, TResult>(negative: TResult) {
  const queueRef = useRef<QueueEntry<TOptions, TResult>[]>([])
  const mountedRef = useRef(false)
  const [queue, setQueue] = useState<QueueEntry<TOptions, TResult>[]>([])
  const [lastShown, setLastShown] = useState<QueueEntry<TOptions, TResult> | null>(null)
  const sessionFocusRef = useRef<HTMLElement | null>(null)
  const focusAfterCloseRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const pending = queueRef.current
      queueRef.current = []
      for (const entry of pending) entry.resolve(negative)
    }
  }, [negative])

  const request = useCallback(
    (options: TOptions) =>
      new Promise<TResult>((resolve) => {
        if (!mountedRef.current) {
          resolve(negative)
          return
        }
        if (queueRef.current.length === 0) {
          const active = typeof document === "undefined" ? null : document.activeElement
          sessionFocusRef.current =
            focusAfterCloseRef.current ?? (active instanceof HTMLElement ? active : null)
          focusAfterCloseRef.current = null
        }
        queueRef.current = [...queueRef.current, { options, resolve }]
        setQueue(queueRef.current)
      }),
    [negative]
  )

  const settle = useCallback((value: TResult) => {
    const [head, ...rest] = queueRef.current
    if (!head) return
    queueRef.current = rest
    setQueue(rest)
    setLastShown(head)
    if (rest.length === 0) {
      focusAfterCloseRef.current = head.options.restoreFocus?.() ?? sessionFocusRef.current
      sessionFocusRef.current = null
    }
    head.resolve(value)
  }, [])

  const head = queue[0] ?? null
  const shown = head ?? lastShown

  const onCloseAutoFocus = useCallback((event: Event) => {
    const target = focusAfterCloseRef.current
    focusAfterCloseRef.current = null
    if (target && target.isConnected) {
      event.preventDefault()
      target.focus()
    }
  }, [])

  return { request, settle, open: head !== null, shown, onCloseAutoFocus }
}

export function useConfirmDialog(): {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
  dialog: ReactElement
} {
  const tCommon = useTranslations("common")
  const { request, settle, open, shown, onCloseAutoFocus } = usePromiseQueue<
    ConfirmDialogOptions,
    boolean
  >(false)
  const options = shown?.options
  const testid = options?.testid ?? "confirm-dialog"

  // Radix's Action / Cancel also close the dialog through onOpenChange(false);
  // preventDefault stops that so one click answers exactly one request.
  const answer = (value: boolean) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    settle(value)
  }

  const dialog = (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(false)
      }}
    >
      <AlertDialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
        data-testid={testid}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          {options?.description ? (
            <AlertDialogDescription className="break-words whitespace-pre-line">
              {options.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        {options?.details ? <div className="text-sm">{options.details}</div> : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={answer(false)} data-testid={`${testid}-cancel`}>
            {options?.cancelLabel ?? tCommon("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={options?.destructive ? "destructive" : "default"}
            onClick={answer(true)}
            data-testid={`${testid}-confirm`}
          >
            {options?.confirmLabel ?? tCommon("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { confirm: request, dialog }
}

export function useChoiceDialog(): {
  choose: (options: ChoiceDialogOptions) => Promise<string | null>
  dialog: ReactElement
} {
  const { request, settle, open, shown, onCloseAutoFocus } = usePromiseQueue<
    ChoiceDialogOptions,
    string | null
  >(null)

  const choose = useCallback(
    (options: ChoiceDialogOptions) =>
      options.options.length === 0 ? Promise.resolve(null) : request(options),
    [request]
  )

  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(null)
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onCloseAutoFocus={onCloseAutoFocus}
        data-testid={shown?.options.testid ?? "choice-dialog"}
      >
        {shown ? (
          // Keyed per request so a queued question starts from its own default.
          <ChoiceDialogBody key={queueKey(shown)} options={shown.options} onAnswer={settle} />
        ) : null}
      </DialogContent>
    </Dialog>
  )

  return { choose, dialog }
}

function ChoiceDialogBody({
  options,
  onAnswer,
}: {
  options: ChoiceDialogOptions
  onAnswer: (value: string | null) => void
}) {
  const tCommon = useTranslations("common")
  const fieldId = useId()
  const valid = options.options.map((option) => option.value)
  const initial =
    options.defaultValue && valid.includes(options.defaultValue)
      ? options.defaultValue
      : (valid[0] ?? "")
  const [value, setValue] = useState(initial)
  const selected = options.options.find((option) => option.value === value)
  const testid = options.testid ?? "choice-dialog"

  return (
    <>
      <DialogHeader>
        <DialogTitle>{options.title}</DialogTitle>
        {options.description ? (
          <DialogDescription className="break-words whitespace-pre-line">
            {options.description}
          </DialogDescription>
        ) : null}
      </DialogHeader>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid.includes(value)) onAnswer(value)
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor={fieldId}>{options.fieldLabel}</Label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger id={fieldId} className="w-full" data-testid={`${testid}-select`}>
              <SelectValue>{selected?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper">
              {options.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="truncate">{option.label}</span>
                    {option.description ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected?.description ? (
            <p className="truncate text-xs text-muted-foreground">{selected.description}</p>
          ) : null}
        </div>
        {options.details ? <div className="text-sm">{options.details}</div> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onAnswer(null)}
            data-testid={`${testid}-cancel`}
          >
            {options.cancelLabel ?? tCommon("cancel")}
          </Button>
          <Button
            type="submit"
            variant={options.destructive ? "destructive" : "default"}
            disabled={!valid.includes(value)}
            data-testid={`${testid}-confirm`}
          >
            {options.confirmLabel ?? tCommon("confirm")}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

/**
 * `onFocusOutside` for a non-modal Popover (or menu) whose content uses these
 * hooks. Radix dismisses a non-modal layer as soon as focus leaves it, and a
 * portaled dialog is "outside" by DOM even though it sits on top — so the host
 * would close, unmount the asking component and lose the request's answer and
 * its inline error. Focus inside a dialog (or a Select listbox opened from one)
 * keeps the host open; everything else dismisses as before.
 */
export function keepOpenWhileNestedDialogFocused(event: Event): void {
  const target = event.target
  if (
    target instanceof Element &&
    target.closest('[role="dialog"], [role="alertdialog"], [data-slot="select-content"]')
  ) {
    event.preventDefault()
  }
}

const entryKeys = new WeakMap<object, string>()
let nextEntryKey = 0

function queueKey(entry: object): string {
  let key = entryKeys.get(entry)
  if (!key) {
    nextEntryKey += 1
    key = `request-${nextEntryKey}`
    entryKeys.set(entry, key)
  }
  return key
}
