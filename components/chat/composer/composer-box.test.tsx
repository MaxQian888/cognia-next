/** @jest-environment jsdom */
import { render as rtlRender, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { createRef } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { ComposerBox, type ComposerBoxProps } from "./composer-box"
import { resolveComposerSkin, type ComposerSkinId } from "@/lib/chat/composer-skin"

// The box is presentational, but its children are not: the attach menus, the
// char counter and the overlays all reach for the prompt-input controller or a
// store. Stubbing them keeps this suite about the box's own arrangement.
jest.mock("./attach-menu", () => ({
  ComposerAttachMenu: () => <button data-testid="attach-menu">attach</button>,
}))
jest.mock("@/components/mobile/chat/composer-plus-menu", () => ({
  ComposerPlusMenu: () => <button data-testid="plus-menu">plus</button>,
}))
jest.mock("./char-counter", () => ({ CharCounter: () => null }))
jest.mock("../composer-chip-overlay", () => ({
  ComposerChipOverlay: () => null,
  TEXTAREA_TYPOGRAPHY: "",
}))
jest.mock("./composer-ghost-text", () => ({ ComposerGhostText: () => null }))
jest.mock("./mobile-ghost-accept", () => ({ MobileGhostAccept: () => null }))
jest.mock("./drag-overlay", () => ({
  DragOverlay: ({ visible }: { visible: boolean }) =>
    visible ? <div data-testid="drag-overlay" /> : null,
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

function props(overrides: Partial<ComposerBoxProps> = {}): ComposerBoxProps {
  return {
    skin: resolveComposerSkin({ skin: "classic" }, { isMobile: false }),
    compactLayout: false,
    isMobile: false,
    permissionMode: "default",
    textInput: { value: "", setInput: jest.fn() },
    textareaRef: createRef<HTMLTextAreaElement>(),
    chipOverlayRef: createRef<HTMLDivElement>(),
    ghostOverlayRef: createRef<HTMLDivElement>(),
    overlaySegments: [],
    maxHeightRem: 12,
    onChange: jest.fn(),
    onKeyDown: jest.fn(),
    onPaste: jest.fn(),
    onSelect: jest.fn(),
    onCompositionStart: jest.fn(),
    onCompositionEnd: jest.fn(),
    ghost: { ghost: "", candidates: [], index: 0, dismiss: jest.fn() },
    acceptGhost: jest.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
    attachmentAccept: "image/*",
    onFilePick: jest.fn(),
    openFileDialog: jest.fn(),
    onPlusAttach: jest.fn(),
    captureSmartSnapshot: jest.fn(),
    smartSnapshotPending: false,
    capabilityMenu: null,
    isDragging: false,
    onDragEnter: jest.fn(),
    onDragOver: jest.fn(),
    onDragLeave: jest.fn(),
    onDrop: jest.fn(),
    sendButton: { mode: "send", disabled: false, variant: "default", queues: false },
    sendIconTransition: { duration: 0 },
    isPreparingAttachments: false,
    submit: jest.fn(),
    onStop: jest.fn(),
    t: (k: string) => k,
    tAttach: (k: string) => k,
    ...overrides,
  } as ComposerBoxProps
}

// `TooltipProvider` is mounted once in `app/layout.tsx`; the box assumes it.
function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: TooltipProvider })
}

function box() {
  return document.querySelector("[data-composer-layout]") as HTMLElement
}

describe("ComposerBox — arrangement", () => {
  it("renders the textarea with the caller's placeholder", () => {
    render(<ComposerBox {...props({ placeholder: "Ask anything" })} />)
    expect(screen.getByPlaceholderText("Ask anything")).toBeInTheDocument()
  })

  it("swaps to the disabled placeholder and disables the textarea", () => {
    render(<ComposerBox {...props({ disabled: true, placeholder: "Ask anything" })} />)
    const ta = screen.getByPlaceholderText("placeholderDisabled")
    expect(ta).toBeDisabled()
  })

  it("marks the layout so the stacked and single-row forms are distinguishable", () => {
    const { rerender } = render(<ComposerBox {...props()} />)
    expect(box()).toHaveAttribute("data-composer-layout", "default")
    rerender(<ComposerBox {...props({ compactLayout: true })} />)
    expect(box()).toHaveAttribute("data-composer-layout", "compact")
  })

  it("opts the surface into the wallpaper-aware tonality system", () => {
    render(<ComposerBox {...props()} />)
    expect(box()).toHaveAttribute("data-tonality", "translucent")
  })
})

describe("ComposerBox — attach cluster", () => {
  it("uses the paperclip menu on desktop", () => {
    render(<ComposerBox {...props({ isMobile: false })} />)
    expect(screen.getByTestId("attach-menu")).toBeInTheDocument()
    expect(screen.queryByTestId("plus-menu")).not.toBeInTheDocument()
  })

  it('uses the single "+" menu on mobile, where 44px targets compete for width', () => {
    render(<ComposerBox {...props({ isMobile: true })} />)
    expect(screen.getByTestId("plus-menu")).toBeInTheDocument()
    expect(screen.queryByTestId("attach-menu")).not.toBeInTheDocument()
  })

  it("shows the drop overlay only while a file drag is active", () => {
    const { rerender } = render(<ComposerBox {...props()} />)
    expect(screen.queryByTestId("drag-overlay")).not.toBeInTheDocument()
    rerender(<ComposerBox {...props({ isDragging: true })} />)
    expect(screen.getByTestId("drag-overlay")).toBeInTheDocument()
  })
})

describe("ComposerBox — send button", () => {
  it("sends on click", () => {
    const submit = jest.fn()
    render(<ComposerBox {...props({ submit })} />)
    screen.getByLabelText("ariaSend").click()
    expect(submit).toHaveBeenCalled()
  })

  it("stops instead of sending while a turn is running", () => {
    const submit = jest.fn()
    const onStop = jest.fn()
    render(
      <ComposerBox
        {...props({
          submit,
          onStop,
          sendButton: { mode: "stop", disabled: false, variant: "default", queues: false },
        })}
      />
    )
    screen.getByLabelText("ariaStop").click()
    expect(onStop).toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it("announces attachment preparation rather than a generic busy state", () => {
    render(
      <ComposerBox
        {...props({
          isPreparingAttachments: true,
          sendButton: { mode: "busy", disabled: true, variant: "default", queues: false },
        })}
      />
    )
    expect(screen.getByLabelText("preparing")).toBeInTheDocument()
  })

  it("renders the draft-edit affordance as a labelled button, not an arrow", () => {
    render(
      <ComposerBox
        {...props({
          sendButton: { mode: "draft", disabled: false, variant: "default", queues: false },
        })}
      />
    )
    expect(screen.getByLabelText("editDraftAria")).toBeInTheDocument()
    expect(screen.queryByLabelText("ariaSend")).not.toBeInTheDocument()
  })
})

describe("ComposerBox — slots", () => {
  it("renders an embedded toolbar when one is supplied", () => {
    render(<ComposerBox {...props({ toolbar: <div data-testid="toolbar" /> })} />)
    expect(screen.getByTestId("toolbar")).toBeInTheDocument()
  })

  it("renders no toolbar row when the toolbar sits outside the box", () => {
    render(<ComposerBox {...props()} />)
    expect(screen.queryByTestId("toolbar")).not.toBeInTheDocument()
  })

  it("mounts the store-backed bridges passed from the composer", () => {
    render(<ComposerBox {...props({ bridges: <div data-testid="bridges" /> })} />)
    expect(screen.getByTestId("bridges")).toBeInTheDocument()
  })
})

// ── The guard that keeps the original look the original ────────────────────
//
// Captured from the pre-skin composer (commit 73ef32c54) by reading the literal
// `cn(...)` arguments, NOT by re-deriving them from the skin table. If a future
// edit routes `classic` through the variable path, or nudges one of these
// utilities, this fails loudly rather than shipping a silently different box.
const CLASSIC_CLASS_STRING =
  "relative flex flex-wrap items-end border shadow-sm " +
  "transition-[border-color,box-shadow,background-color] duration-200 motion-reduce:transition-none " +
  "focus-within:border-primary/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/15 " +
  "gap-2 rounded-2xl border-input/60 bg-background/70 px-2 py-2"

function classSet(source: HTMLElement | string) {
  const raw = typeof source === "string" ? source : source.className
  return new Set(raw.split(/\s+/).filter(Boolean))
}

describe("classic parity — today's composer is unchanged", () => {
  it("renders exactly the pre-skin utility set", () => {
    render(<ComposerBox {...props()} />)
    expect(classSet(box())).toEqual(classSet(CLASSIC_CLASS_STRING))
  })

  it("emits NO inline custom properties, so nothing can drift", () => {
    render(<ComposerBox {...props()} />)
    expect(box().getAttribute("style")).toBeNull()
    expect(box().className).not.toContain("var(--composer-")
  })

  it("keeps honouring compactLayout, which the legacy setting still drives", () => {
    render(<ComposerBox {...props({ compactLayout: true })} />)
    const cls = classSet(box())
    expect(cls.has("rounded-[1.75rem]")).toBe(true)
    expect(cls.has("px-3")).toBe(true)
  })
})

describe("non-classic skins drive geometry from variables", () => {
  it.each(["airy", "dense", "full", "focus"] as ComposerSkinId[])(
    "%s sets the composer custom properties",
    (id) => {
      const skin = resolveComposerSkin({ skin: id }, { isMobile: false })
      render(<ComposerBox {...props({ skin })} />)
      const style = box().getAttribute("style") ?? ""
      expect(style).toContain("--composer-radius")
      expect(style).toContain("--composer-pad-x")
      expect(box().className).toContain("rounded-[var(--composer-radius)]")
      // and none of classic's hardcoded geometry survives
      expect(classSet(box()).has("rounded-2xl")).toBe(false)
    }
  )

  it("labels the surface so a skin is addressable from CSS and from a test", () => {
    render(
      <ComposerBox
        {...props({ skin: resolveComposerSkin({ skin: "dense" }, { isMobile: false }) })}
      />
    )
    expect(box()).toHaveAttribute("data-composer-skin", "dense")
  })

  it("ignores compactLayout's classic-only geometry", () => {
    const skin = resolveComposerSkin({ skin: "airy" }, { isMobile: false })
    render(<ComposerBox {...props({ skin, compactLayout: true })} />)
    expect(classSet(box()).has("rounded-[1.75rem]")).toBe(false)
  })
})
