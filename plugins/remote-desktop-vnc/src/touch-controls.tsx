/**
 * Phone controls for the VNC viewer (ADR-0234 Phase 3), shown in control mode
 * on a touch screen.
 *
 *  * {@link VncTrackpadLayer} sits over noVNC's canvas in trackpad mode and
 *    turns gestures into mouse events on that canvas at a drawn pointer, so
 *    noVNC does the scaling and sends them. In direct-touch mode it is not
 *    rendered and noVNC's own touch gestures apply.
 *  * {@link VncKeyBar} has the keys a phone keyboard lacks (latching Ctrl,
 *    Alt and Super; Esc, Tab, arrows, Ctrl+Alt+Del), the trackpad/touch
 *    switch, and a soft-keyboard toggle whose typed text is sent as keysyms.
 *
 * Inline styles only: this renders in the app document from a plugin, which
 * cannot rely on the app's stylesheet scanning its sources.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CompositionEvent as ReactCompositionEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"

import { PLUGIN_ID } from "./ids"
import {
  KEYSYM,
  keysymForChar,
  pressWithModifiers,
  TrackpadGestures,
  type Modifier,
  type SendKey,
} from "./touch-input"

export type TouchInputMode = "trackpad" | "direct"

interface Point {
  x: number
  y: number
}

export interface VncTrackpadLayerProps {
  /** noVNC's canvas, once it exists. */
  canvas: () => HTMLCanvasElement | null
  /** Test seam: the gesture clock. */
  now?: () => number
}

const CURSOR_SIZE = 14

export function VncTrackpadLayer({ canvas, now = () => performance.now() }: VncTrackpadLayerProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const layer = useRef<HTMLDivElement | null>(null)
  // Pointer position relative to the canvas, in CSS pixels.
  const cursor = useRef<Point | null>(null)
  const held = useRef(0)
  const [drawn, setDrawn] = useState<Point | null>(null)
  const gestures = useRef<TrackpadGestures | null>(null)

  const place = useCallback(() => {
    const target = canvas()
    const box = layer.current?.getBoundingClientRect()
    if (!target || !box || !cursor.current) return null
    const rect = target.getBoundingClientRect()
    return {
      target,
      clientX: rect.left + cursor.current.x,
      clientY: rect.top + cursor.current.y,
      layerX: rect.left - box.left + cursor.current.x,
      layerY: rect.top - box.top + cursor.current.y,
    }
  }, [canvas])

  const dispatch = useCallback(
    (type: "mousemove" | "mousedown" | "mouseup") => {
      const at = place()
      if (!at) return
      at.target.dispatchEvent(
        new MouseEvent(type, {
          clientX: at.clientX,
          clientY: at.clientY,
          buttons: held.current,
          bubbles: true,
          cancelable: true,
        })
      )
      setDrawn({ x: at.layerX, y: at.layerY })
    },
    [place]
  )

  useEffect(() => {
    gestures.current = new TrackpadGestures({
      move: (dx, dy) => {
        const target = canvas()
        if (!target) return
        const rect = target.getBoundingClientRect()
        const from = cursor.current ?? { x: rect.width / 2, y: rect.height / 2 }
        cursor.current = {
          x: Math.min(Math.max(from.x + dx, 0), Math.max(rect.width - 1, 0)),
          y: Math.min(Math.max(from.y + dy, 0), Math.max(rect.height - 1, 0)),
        }
        dispatch("mousemove")
      },
      buttons: (mask) => {
        const target = canvas()
        if (!target) return
        if (!cursor.current) {
          const rect = target.getBoundingClientRect()
          cursor.current = { x: rect.width / 2, y: rect.height / 2 }
        }
        const previous = held.current
        held.current = mask
        if (mask & ~previous) dispatch("mousedown")
        else if (previous & ~mask) dispatch("mouseup")
      },
      scroll: (dy) => {
        const at = place()
        if (!at) return
        at.target.dispatchEvent(
          new WheelEvent("wheel", {
            clientX: at.clientX,
            clientY: at.clientY,
            deltaY: dy,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          })
        )
      },
    })
    return () => {
      gestures.current?.cancel()
      gestures.current = null
    }
  }, [canvas, dispatch, place])

  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    gestures.current?.down(event.pointerId, event.clientX, event.clientY, now())
  }
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    gestures.current?.move(event.pointerId, event.clientX, event.clientY)
  }
  const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    gestures.current?.up(event.pointerId, now())
  }

  return (
    <div
      ref={layer}
      role="presentation"
      aria-label={t("touch.surfaceLabel")}
      data-testid="vnc-trackpad"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => gestures.current?.cancel()}
      onContextMenu={(event) => event.preventDefault()}
      style={{ position: "absolute", inset: 0, touchAction: "none", userSelect: "none" }}
    >
      {drawn ? (
        <div
          aria-hidden
          data-testid="vnc-trackpad-cursor"
          style={{
            position: "absolute",
            left: drawn.x - CURSOR_SIZE / 2,
            top: drawn.y - CURSOR_SIZE / 2,
            width: CURSOR_SIZE,
            height: CURSOR_SIZE,
            borderRadius: "50%",
            border: "2px solid #fff",
            background: "rgba(0,0,0,0.35)",
            boxShadow: "0 0 2px #000",
            pointerEvents: "none",
          }}
        />
      ) : null}
    </div>
  )
}

export interface VncKeyBarProps {
  sendKey: SendKey
  sendCtrlAltDel: () => void
  inputMode: TouchInputMode
  onInputModeChange: (mode: TouchInputMode) => void
}

const BAR: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 4,
  padding: "6px 8px",
  background: "#1b1b1b",
  borderTop: "1px solid #333",
}

function keyStyle(pressed: boolean): CSSProperties {
  return {
    minWidth: 40,
    height: 34,
    padding: "0 10px",
    borderRadius: 6,
    border: "1px solid #444",
    background: pressed ? "#3b82f6" : "#2a2a2a",
    color: "#f5f5f5",
    fontSize: 13,
  }
}

/** A key that keeps the soft keyboard's focus where it is. */
function Key({
  label,
  text,
  pressed,
  onPress,
}: {
  label: string
  text: string
  pressed?: boolean
  onPress: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      style={keyStyle(Boolean(pressed))}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      {text}
    </button>
  )
}

const ARROWS = [
  ["left", KEYSYM.Left, "←"],
  ["up", KEYSYM.Up, "↑"],
  ["down", KEYSYM.Down, "↓"],
  ["right", KEYSYM.Right, "→"],
] as const

export function VncKeyBar({
  sendKey,
  sendCtrlAltDel,
  inputMode,
  onInputModeChange,
}: VncKeyBarProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const [latched, setLatched] = useState<Modifier[]>([])
  const input = useRef<HTMLInputElement | null>(null)
  const [typing, setTyping] = useState(false)

  const press = (keysym: number) => {
    pressWithModifiers(sendKey, keysym, latched)
    // One-shot, like a phone keyboard's shift: the latch covers one key.
    setLatched([])
  }
  const toggle = (modifier: Modifier) =>
    setLatched((current) =>
      current.includes(modifier)
        ? current.filter((entry) => entry !== modifier)
        : [...current, modifier]
    )

  const typeText = (text: string) => {
    // The latch covers the first character only.
    let modifiers: readonly Modifier[] = latched
    for (const char of text) {
      const keysym = keysymForChar(char)
      if (keysym === null) continue
      pressWithModifiers(sendKey, keysym, modifiers)
      modifiers = []
    }
    setLatched([])
  }
  // The native `beforeinput`: React's `onBeforeInput` is built from legacy
  // `textInput`/`keypress` events and carries no `inputType`, so it cannot
  // tell a soft keyboard's backspace from text.
  const handlers = useRef({ press, typeText })
  useLayoutEffect(() => {
    handlers.current = { press, typeText }
  })
  useEffect(() => {
    const field = input.current
    if (!field) return
    const onBeforeInput = (event: InputEvent) => {
      // An IME composes first and commits at `compositionend`; the
      // in-progress text is not the user's input yet and cannot be cancelled.
      if (event.inputType === "insertCompositionText") return
      event.preventDefault()
      if (event.inputType === "deleteContentBackward") {
        handlers.current.press(KEYSYM.BackSpace)
        return
      }
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        handlers.current.press(KEYSYM.Return)
        return
      }
      handlers.current.typeText(event.data ?? "")
    }
    field.addEventListener("beforeinput", onBeforeInput)
    return () => field.removeEventListener("beforeinput", onBeforeInput)
  }, [])
  const onCompositionEnd = (event: ReactCompositionEvent<HTMLInputElement>) => {
    typeText(event.data)
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Some soft keyboards report these as keys rather than input.
    if (event.key === "Enter") {
      event.preventDefault()
      press(KEYSYM.Return)
    } else if (event.key === "Backspace") {
      event.preventDefault()
      press(KEYSYM.BackSpace)
    }
  }

  const toggleKeyboard = () => {
    if (typing) input.current?.blur()
    else input.current?.focus()
  }

  return (
    <div role="toolbar" aria-label={t("keys.barLabel")} style={BAR} data-testid="vnc-key-bar">
      <Key
        label={t("keys.ctrl")}
        text={t("keys.ctrl")}
        pressed={latched.includes("ctrl")}
        onPress={() => toggle("ctrl")}
      />
      <Key
        label={t("keys.alt")}
        text={t("keys.alt")}
        pressed={latched.includes("alt")}
        onPress={() => toggle("alt")}
      />
      <Key
        label={t("keys.meta")}
        text={t("keys.meta")}
        pressed={latched.includes("meta")}
        onPress={() => toggle("meta")}
      />
      <Key label={t("keys.esc")} text={t("keys.esc")} onPress={() => press(KEYSYM.Escape)} />
      <Key label={t("keys.tab")} text={t("keys.tab")} onPress={() => press(KEYSYM.Tab)} />
      {ARROWS.map(([name, keysym, glyph]) => (
        <Key key={name} label={t(`keys.${name}`)} text={glyph} onPress={() => press(keysym)} />
      ))}
      <Key label={t("keys.ctrlAltDel")} text={t("keys.ctrlAltDel")} onPress={sendCtrlAltDel} />
      <Key
        label={t("keys.keyboard")}
        text={t("keys.keyboard")}
        pressed={typing}
        onPress={toggleKeyboard}
      />
      <Key
        label={inputMode === "trackpad" ? t("touch.switchToDirect") : t("touch.switchToTrackpad")}
        text={inputMode === "trackpad" ? t("touch.trackpad") : t("touch.direct")}
        onPress={() => onInputModeChange(inputMode === "trackpad" ? "direct" : "trackpad")}
      />
      <input
        ref={input}
        aria-label={t("keys.keyboardInput")}
        data-testid="vnc-soft-keyboard"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        value=""
        onChange={() => undefined}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={onKeyDown}
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        style={{ position: "absolute", opacity: 0, width: 1, height: 1, pointerEvents: "none" }}
      />
    </div>
  )
}

/** Whether this screen is driven by touch: the default for phone controls. */
export function prefersTouchInput(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true
}
