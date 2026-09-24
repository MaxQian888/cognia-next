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
// Stubbed, but not to nothing: the overlay is the composer's TEXT layer now,
// so whether it is painting is part of the box's arrangement.
jest.mock("../composer-chip-overlay", () => ({
  ComposerChipOverlay: ({
    hidden,
    routeState,
  }: {
    hidden?: boolean
    routeState?: (segment: { start: number; name: string }) => string | undefined
  }) => (
    <div
      data-testid="composer-chip-overlay"
      data-hidden={hidden ? "true" : undefined}
      // Probes the forwarded callback with a leading `@codex` segment.
      data-leading-route={routeState?.({ start: 0, name: "codex" })}
    />
  ),
  TEXTAREA_TYPOGRAPHY: "",
  // Real value, not "": the preview box reads it to stay at the textarea's
  // size, and the test below asserts it lands.
  OVERLAY_FONT_SIZE: "var(--composer-text-size, 0.875rem)",
}))
// Both surface only what the touch split decides: whether the manual
// completion key is advertised, and whether the card drops its keycaps.
jest.mock("./composer-ghost-text", () => ({
  ComposerGhostText: ({ manualHint }: { manualHint?: string }) =>
    manualHint ? <div data-testid="ghost-manual-hint">{manualHint}</div> : null,
}))
jest.mock("./composer-ghost-card", () => ({
  ComposerGhostCard: ({ open, isMobile }: { open: boolean; isMobile?: boolean }) =>
    open ? (
      <div data-testid="composer-ghost-card" data-touch={isMobile ? "true" : undefined} />
    ) : null,
}))
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
    shellDiagnosticOverlayRef: createRef<HTMLDivElement>(),
    overlaySegments: [],
    maxHeightRem: 12,
    onChange: jest.fn(),
    onKeyDown: jest.fn(),
    onPaste: jest.fn(),
    onSelect: jest.fn(),
    onCompositionStart: jest.fn(),
    onCompositionEnd: jest.fn(),
    ghost: {
      ghost: "",
      suggestion: null,
      candidates: [],
      index: 0,
      querying: false,
      streaming: false,
      completionError: false,
      dismiss: jest.fn(),
      cycleNext: jest.fn(),
      cyclePrev: jest.fn(),
      cycleTo: jest.fn(),
      retry: jest.fn(),
    },
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

  it("renders the context row inside the card, ahead of the textarea", () => {
    render(
      <ComposerBox
        {...props({ contextRow: <div data-testid="context-row-content">staged tiles</div> })}
      />
    )
    const row = screen.getByTestId("context-row-content")
    expect(box()).toContainElement(row)
    // First full-width flex row: it must precede the textarea's wrapper in
    // the box (default order 0 vs the textarea wrapper's order-1).
    const textarea = screen.getByRole("textbox")
    expect(row.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("omits the context row's wrapper entirely when nothing is staged", () => {
    render(<ComposerBox {...props({ contextRow: null })} />)
    expect(screen.queryByTestId("context-row-content")).not.toBeInTheDocument()
  })
})

describe("ComposerBox — attach cluster", () => {
  it("uses the paperclip menu on desktop", () => {
    render(<ComposerBox {...props({ isMobile: false })} />)
    expect(screen.getByTestId("attach-menu")).toBeInTheDocument()
    expect(screen.queryByTestId("plus-menu")).not.toBeInTheDocument()
  })

  it('uses the single "+" menu in the native shell, whose camera and album it drives', () => {
    render(<ComposerBox {...props({ isMobile: true, nativeShell: true })} />)
    expect(screen.getByTestId("plus-menu")).toBeInTheDocument()
    expect(screen.queryByTestId("attach-menu")).not.toBeInTheDocument()
  })

  // A 375px browser renders the phone layout, but has no native pickers: its
  // media tiles would all degrade to the file picker the paperclip already is.
  it("keeps the paperclip menu in a phone-shaped browser layout", () => {
    render(<ComposerBox {...props({ isMobile: true, nativeShell: false })} />)
    expect(screen.getByTestId("attach-menu")).toBeInTheDocument()
    expect(screen.queryByTestId("plus-menu")).not.toBeInTheDocument()
  })

  it("floors the send button to the touch target in the phone layout", () => {
    render(<ComposerBox {...props({ isMobile: true })} />)
    expect(screen.getByRole("button", { name: "ariaSend" }).className).toContain("touch-target")
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

  // The draft mode was built, then left unreachable behind a hard-coded
  // `false` — and its button called `submit()` on an empty box. It opens the
  // review dialog now.
  it("opens the draft review instead of submitting in draft mode", () => {
    const submit = jest.fn()
    const onReviewDrafts = jest.fn()
    render(
      <ComposerBox
        {...props({
          submit,
          onReviewDrafts,
          pendingDraftCount: 2,
          sendButton: { mode: "draft", disabled: false, variant: "secondary", queues: false },
        })}
      />
    )
    const button = screen.getByTestId("composer-review-drafts")
    expect(button).toHaveAccessibleName("reviewDraftsAria")
    expect(button).toHaveTextContent("reviewDraftsLabel")
    expect(button).toHaveTextContent("2")
    button.click()
    expect(onReviewDrafts).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })

  it("does not offer a draft review it cannot open", () => {
    render(
      <ComposerBox
        {...props({
          sendButton: { mode: "draft", disabled: false, variant: "secondary", queues: false },
        })}
      />
    )
    expect(screen.getByTestId("composer-review-drafts")).toBeDisabled()
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

  it("renders the draft review as a labelled button, not an arrow", () => {
    render(
      <ComposerBox
        {...props({
          onReviewDrafts: jest.fn(),
          sendButton: { mode: "draft", disabled: false, variant: "default", queues: false },
        })}
      />
    )
    expect(screen.getByLabelText("reviewDraftsAria")).toBeInTheDocument()
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

// Every resolved token must reach the DOM. `sendSizePx`, `sendShape` and `mono`
// were each computed, clamped and floored for touch — and then ignored by the
// box, which kept hardcoding `size-9 rounded-full` and the interface font.
// Nothing caught it until the rendered box was looked at.
describe("ComposerBox — resolved tokens actually reach the DOM", () => {
  it("sizes and shapes the send button from the skin", () => {
    const skin = resolveComposerSkin({ skin: "dense" }, { isMobile: false })
    render(<ComposerBox {...props({ skin })} />)
    const send = screen.getByLabelText("ariaSend")
    expect(send.className).toContain("size-[var(--composer-send-size)]")
    expect(send.className).toContain("rounded-[var(--composer-inner-radius)]")
    expect(send.className).not.toContain("size-9")
  })

  it("keeps classic's literal send button", () => {
    render(<ComposerBox {...props()} />)
    const send = screen.getByLabelText("ariaSend")
    expect(send.className).toContain("size-9")
    expect(send.className).toContain("rounded-full")
    expect(send.className).not.toContain("var(--composer-send-size)")
  })

  it("puts the textarea in the code font when the skin asks", () => {
    const skin = resolveComposerSkin({ skin: "dense" }, { isMobile: false })
    render(<ComposerBox {...props({ skin })} />)
    expect(screen.getByLabelText("ariaMessage").className).toContain("font-mono")
  })

  it("never puts classic in the code font", () => {
    render(<ComposerBox {...props()} />)
    expect(screen.getByLabelText("ariaMessage").className).not.toContain("font-mono")
  })

  it("honours a mono override on a skin that does not default to it", () => {
    const skin = resolveComposerSkin(
      { skin: "airy", skinOverrides: { mono: true } },
      { isMobile: false }
    )
    render(<ComposerBox {...props({ skin })} />)
    expect(screen.getByLabelText("ariaMessage").className).toContain("font-mono")
  })
})

describe("ComposerBox — route tint", () => {
  it("hands the overlay the composer's route verdict for a mention", () => {
    const routeState = jest.fn(() => "unavailable" as const)
    render(<ComposerBox {...props({ routeState })} />)
    expect(screen.getByTestId("composer-chip-overlay")).toHaveAttribute(
      "data-leading-route",
      "unavailable"
    )
    expect(routeState).toHaveBeenCalledWith({ start: 0, name: "codex" })
  })

  it("paints no route without a verdict", () => {
    render(<ComposerBox {...props()} />)
    expect(screen.getByTestId("composer-chip-overlay")).not.toHaveAttribute("data-leading-route")
  })
})

describe("ComposerBox — the preview owns the words", () => {
  const withPreview = (on: boolean) =>
    props({
      textInput: { value: "review {{module}} now", setInput: jest.fn() },
      preview: { on, text: "review login now", toggle: jest.fn() },
    })

  it("stands the chip overlay down while the parameter preview is showing", () => {
    // The overlay paints the composer's text now. In preview mode a second box
    // renders the SUBSTITUTED sentence, and both drawing at once is exactly the
    // doubled, overlapping text the preview toggle used to produce.
    render(<ComposerBox {...withPreview(true)} />)
    expect(screen.getByTestId("composer-chip-overlay")).toHaveAttribute("data-hidden", "true")
    expect(screen.getByTestId("composer-param-preview")).toHaveTextContent("review login now")
  })

  it("sizes the preview box like the textarea it stands in for", () => {
    // The preview replaces the textarea in place, so `text-sm` alone is wrong
    // wherever the iOS zoom guard is making the real textarea 16px: toggling
    // preview on would reflow the very sentence it exists to show you.
    render(<ComposerBox {...withPreview(true)} />)
    expect(screen.getByTestId("composer-param-preview").style.fontSize).toBe(
      "var(--composer-text-size, 0.875rem)"
    )
  })

  it("paints the overlay again once the preview is off", () => {
    render(<ComposerBox {...withPreview(false)} />)
    expect(screen.getByTestId("composer-chip-overlay")).not.toHaveAttribute("data-hidden")
  })

  it("moves the bookmark into the corner when there is no preview toggle", () => {
    render(<ComposerBox {...props({ saveAsTemplate: jest.fn(), preview: null })} />)
    expect(screen.getByTestId("composer-save-as-template").className).toContain("end-1")
    expect(screen.queryByTestId("composer-param-preview-toggle")).toBeNull()
  })

  it("gives the corner back to the preview toggle when the message has parameters", () => {
    render(<ComposerBox {...props({ ...withPreview(false), saveAsTemplate: jest.fn() })} />)
    expect(screen.getByTestId("composer-save-as-template").className).toContain("end-7")
    expect(screen.getByTestId("composer-param-preview-toggle").className).toContain("end-1")
  })

  it("keeps the two corner controls clickable above the text layers", () => {
    // Both sit inside the textarea's box. A positioned element with
    // `z-index: auto` paints under a sibling with a positive one, and hit
    // testing follows paint order — so without an explicit z they were dead.
    render(<ComposerBox {...props({ ...withPreview(false), saveAsTemplate: jest.fn() })} />)
    expect(screen.getByTestId("composer-save-as-template").className).toContain("z-[3]")
    expect(screen.getByTestId("composer-param-preview-toggle").className).toContain("z-[3]")
  })
})

describe("ComposerBox — keyboard hints follow the input, not the width", () => {
  // `isMobile` is layout (a narrow window gets the phone arrangement);
  // `touchInput` is whether there is a keyboard to press the hinted keys on.
  const withDraft = (overrides: Partial<ComposerBoxProps>) => {
    const base = props()
    return props({
      textInput: { value: "a draft worth continuing", setInput: jest.fn() },
      ghost: { ...base.ghost, manualAvailable: true },
      ...overrides,
    })
  }

  it("does not advertise the manual-completion key on a touch screen", () => {
    render(<ComposerBox {...withDraft({ isMobile: true, touchInput: true })} />)
    expect(screen.queryByTestId("ghost-manual-hint")).not.toBeInTheDocument()
  })

  it("keeps advertising it in a narrow desktop window", () => {
    render(<ComposerBox {...withDraft({ isMobile: true, touchInput: false })} />)
    expect(screen.getByTestId("ghost-manual-hint")).toHaveTextContent("ghostManualHint")
  })

  it("drops the suggestion card's keycaps only for touch input", () => {
    const querying = (touchInput: boolean) => {
      const base = props()
      return props({ isMobile: true, touchInput, ghost: { ...base.ghost, querying: true } })
    }
    const { rerender } = render(<ComposerBox {...querying(false)} />)
    expect(screen.getByTestId("composer-ghost-card")).not.toHaveAttribute("data-touch")
    rerender(<ComposerBox {...querying(true)} />)
    expect(screen.getByTestId("composer-ghost-card")).toHaveAttribute("data-touch", "true")
  })
})
