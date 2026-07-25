/**
 * Capture of the frame Ink last committed to the terminal.
 *
 * In-app text selection needs to answer "what character is at row 12, column
 * 40?" — and Ink has no such API: it renders a React tree straight to an escape-
 * laden string and writes it to `stdout`. So we tap the write. {@link createFrameBuffer}
 * wraps the real stdout in a delegating proxy that Ink is handed via
 * `render(node, { stdout })`; every write still reaches the terminal untouched,
 * but the ones carrying displayable content are remembered as the current frame.
 *
 * Two writers share that stream, so the tap has to tell them apart:
 *   • Ink's committed frames — text, possibly prefixed by `log-update`'s erase run
 *   • the App's terminal chrome — alt-screen switches, mouse tracking, the window
 *     title, an OSC 52 clipboard write, synchronized-update markers
 * The second group is pure control traffic ({@link isControlOnly}) and is passed
 * through without disturbing the stored frame.
 *
 * The proxy delegates every other property to the real stream (`columns`,
 * `rows`, `on("resize")`, `isTTY`, …) and keeps its prototype chain, so Ink's
 * `stdout instanceof Stream` check and its resize handling behave exactly as
 * they do against the bare `process.stdout`.
 *
 * IMPORTANT — this depends on Ink's `incrementalRendering` being OFF (its
 * default, and pinned explicitly in `mount.tsx`). With it off, `log-update`
 * rewrites the WHOLE frame on every commit, which is what makes a single write
 * a complete picture of the screen. Turned on, Ink emits only the changed lines
 * interleaved with cursor moves, and a lone write would no longer describe the
 * frame — the stored lines would be a diff, and a selection would copy the
 * wrong text. Do not flip that option without teaching this module to apply
 * incremental updates.
 */
import {
  isControlOnly,
  stripAnsi,
  stripLeadingCursorControls,
  stripTrailingCursorControls,
} from "./ansi-columns"

/** The slice of a writable stream this module needs (test seam: a plain object
 * with a `write` is enough). */
export interface FrameStream {
  write: (data: string) => unknown
}

export interface FrameBuffer {
  /** The stream to hand to Ink's `render(node, { stdout })`. */
  stdout: NodeJS.WriteStream
  /** Styled lines of the last committed frame, top row first. Empty until Ink
   * commits its first frame. */
  frame(): readonly string[]
  /** {@link frame} with every escape sequence stripped — the text the user sees,
   * and the text a selection copies. */
  plain(): readonly string[]
  /** Write straight to the underlying stream, bypassing the tap. Used for the
   * selection's imperative repaint, which must not be mistaken for a frame. */
  raw: (data: string) => void
  /** Subscribe to "a frame was just committed". Returns an unsubscribe. The
   * selection overlay re-applies itself here, since Ink's repaint wipes it. */
  onFrame: (cb: () => void) => () => void
}

/**
 * Wrap `base` so Ink's committed frames are captured on the way to the terminal.
 * The returned {@link FrameBuffer.stdout} is a drop-in replacement for the stream
 * it wraps.
 */
export function createFrameBuffer(base: FrameStream): FrameBuffer {
  let styled: string[] = []
  let plainLines: string[] = []
  const listeners = new Set<() => void>()

  const raw = (data: string): void => void base.write(data)

  const capture = (data: string): void => {
    // Control-only traffic (mouse toggles, title, OSC 52) leaves the frame alone.
    if (isControlOnly(data)) return
    // Drop the cursor/erase run Ink wraps the frame in: it belongs to the
    // transition BETWEEN frames, and re-emitting it while repainting a row would
    // rewind the cursor into the middle of the screen.
    const body = stripTrailingCursorControls(stripLeadingCursorControls(data))
    styled = body.split("\n")
    plainLines = styled.map(stripAnsi)
    for (const cb of listeners) cb()
  }

  const write = (data: string, ...rest: unknown[]): boolean => {
    const result = (base.write as (...args: unknown[]) => unknown)(data, ...rest)
    // Capture AFTER forwarding so the terminal never waits on our bookkeeping,
    // and a throw in a listener can't swallow the frame itself.
    if (typeof data === "string") capture(data)
    return result !== false
  }

  // Bound-method cache: a Proxy `get` must return functions bound to the real
  // stream (EventEmitter/tty internals read own properties off `this`), and Ink
  // registers then removes a resize listener, so the method identity has to be
  // stable across gets.
  const bound = new Map<string | symbol, unknown>()
  const stdout = new Proxy(base as unknown as NodeJS.WriteStream, {
    get(target, prop) {
      if (prop === "write") return write
      // Read with `target` as the receiver, not the proxy, so accessor
      // properties (`columns`, `rows`) see the real stream's internals.
      const value = Reflect.get(target, prop, target)
      if (typeof value !== "function") return value
      if (!bound.has(prop)) bound.set(prop, value.bind(target))
      return bound.get(prop)
    },
  })

  return {
    stdout,
    frame: () => styled,
    plain: () => plainLines,
    raw,
    onFrame: (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
}
