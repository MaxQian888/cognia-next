/**
 * CJS-compatible mock for `ink` used in Jest tests.
 *
 * `ink` (v7) is ESM-only with a deep ESM dependency chain (chalk, ansi-escapes,
 * cli-truncate, string-width, yoga-layout, …) that this repo's `next/jest` setup
 * does not transform — the same reason shiki / react-markdown are mocked here
 * rather than transformed. The real `ink` is used at runtime (the CLI bundles
 * via esbuild and Node runs ESM natively); Jest only needs the surface the TUI
 * components consume.
 *
 * Rendering model: `<Box>` → `<div>`, `<Text>` → `<span>`, so the component
 * trees render under jsdom and React Testing Library can assert on text content
 * and structure. Layout props (flexDirection, gap, borderStyle, …) are accepted
 * and dropped. Keyboard input is captured: every `useInput(handler)` registers
 * its handler so a test can drive it via `__fireInput(input, key)`.
 */
const React = require("react")

// ── Registry so tests can drive keyboard input deterministically ──────────────
const inputHandlers = new Set()

function __fireInput(input, key = {}) {
  const fullKey = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...key,
  }
  for (const handler of inputHandlers) handler(input, fullKey)
}

function __resetInk() {
  inputHandlers.clear()
}

// ── Components ────────────────────────────────────────────────────────────────
// `forwardRef` so a measured `<Box ref>` (ScrollView's viewport/content) accepts
// a ref without React's "function components cannot be given refs" warning; the
// real ink Box exposes a Yoga DOMElement here, the mock just exposes the div.
const Box = React.forwardRef(function Box({ children, ...rest }, ref) {
  // Drop ink-only layout props; jsdom doesn't need them.
  return React.createElement(
    "div",
    { "data-ink": "box", ref, ...passthroughTestProps(rest) },
    children
  )
})

const Text = React.forwardRef(function Text({ children, color, backgroundColor, ...rest }, ref) {
  return React.createElement(
    "span",
    {
      "data-ink": "text",
      "data-color": color,
      "data-bg": backgroundColor,
      ref,
      ...passthroughTestProps(rest),
    },
    children
  )
})

// Keep only attributes that are safe/useful on a DOM node for assertions.
function passthroughTestProps(props) {
  const out = {}
  if (props && typeof props === "object") {
    if (props["data-testid"]) out["data-testid"] = props["data-testid"]
    if (props.flexGrow !== undefined) out["data-flex-grow"] = String(props.flexGrow)
    if (props.flexShrink !== undefined) out["data-flex-shrink"] = String(props.flexShrink)
    if (props.id) out.id = props.id
  }
  return out
}

function Newline({ count = 1 }) {
  return React.createElement("span", { "data-ink": "newline" }, "\n".repeat(count))
}

function Spacer() {
  return React.createElement("div", { "data-ink": "spacer" })
}

function Static({ items, children }) {
  if (Array.isArray(items) && typeof children === "function") {
    return React.createElement(
      React.Fragment,
      null,
      items.map((item, index) => children(item, index))
    )
  }
  return React.createElement(React.Fragment, null, children)
}

function Transform({ children }) {
  return React.createElement(React.Fragment, null, children)
}

// ── Hooks ─────────────────────────────────────────────────────────────────────
function useInput(handler, options = {}) {
  React.useEffect(() => {
    if (options.isActive === false) return undefined
    inputHandlers.add(handler)
    return () => {
      inputHandlers.delete(handler)
    }
  })
}

const exitFn = jest.fn()
function useApp() {
  return { exit: exitFn }
}

function useStdin() {
  return {
    stdin: process.stdin,
    setRawMode: jest.fn(),
    isRawModeSupported: true,
    internal_exitOnCtrlC: false,
  }
}

function useStdout() {
  return { stdout: process.stdout, write: jest.fn() }
}

function useStderr() {
  return { stderr: process.stderr, write: jest.fn() }
}

function useFocus() {
  return { isFocused: true }
}

function useFocusManager() {
  return { focus: jest.fn(), focusNext: jest.fn(), focusPrevious: jest.fn(), enableFocus: jest.fn(), disableFocus: jest.fn() }
}

const setCursorPosition = jest.fn()
function useCursor() {
  return { setCursorPosition }
}

function useBoxMetrics() {
  return { width: 0, height: 0, left: 0, top: 0, hasMeasured: false }
}

function measureElement() {
  return { width: 80, height: 24 }
}

// ── Mount (not exercised by component tests; mount.tsx injects a fake) ─────────
function render(_node) {
  return {
    rerender: jest.fn(),
    unmount: jest.fn(),
    clear: jest.fn(),
    cleanup: jest.fn(),
    waitUntilExit: () => Promise.resolve(),
  }
}

module.exports = {
  __esModule: true,
  Box,
  Text,
  Newline,
  Spacer,
  Static,
  Transform,
  useInput,
  useApp,
  useStdin,
  useStdout,
  useStderr,
  useFocus,
  useFocusManager,
  useCursor,
  useBoxMetrics,
  measureElement,
  render,
  // Test helpers (not part of ink's public API).
  __fireInput,
  __resetInk,
}
