import { createRef, useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { SELECTION_SHADOW_PAD } from "@/lib/tauri/selection-toolbar"
import { SelectionToolbarCapsule, type SelectionToolbarPhase } from "./selection-toolbar-capsule"
import {
  resolveVisibleActions,
  type SelectionActionId,
  type TargetLocale,
} from "./selection-toolbar-actions"
import type { SelectionToolbarGeometryHandles } from "./use-selection-toolbar-geometry"

/**
 * The capsule is the whole visible surface of the system-wide selection
 * toolbar. In production it renders alone inside a transparent, frameless
 * Tauri window that is measured to fit it — so these stories reproduce that
 * window rather than dropping the pill onto a Storybook page: the window's
 * `SELECTION_SHADOW_PAD` breathing room is load-bearing (without it the
 * `shadow-xl` is clipped, which is one of the defects this module fixed).
 */
function OverlayWindow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex w-max items-center justify-center rounded-lg"
      style={{ padding: SELECTION_SHADOW_PAD }}
    >
      {children}
    </div>
  )
}

function makeGeometry(placement: "above" | "below" = "above"): SelectionToolbarGeometryHandles {
  return {
    shellRef: createRef<HTMLDivElement>(),
    capsuleRef: createRef<HTMLDivElement>(),
    panelRef: createRef<HTMLElement>(),
    ghostRef: createRef<HTMLDivElement>(),
    placement,
    measured: true,
    remeasure: () => {},
  }
}

const CHORDS: Record<string, string> = {
  "selection.copy": "alt+shift+1",
  "selection.explain": "alt+shift+2",
  "selection.translate": "alt+shift+3",
  "selection.ask": "alt+shift+4",
  "selection.remember": "alt+shift+5",
  "selection.speak": "alt+shift+6",
}

const meta = {
  title: "SelectionToolbar/Capsule",
  component: SelectionToolbarCapsule,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <OverlayWindow>
        <Story />
      </OverlayWindow>
    ),
  ],
  args: {
    geometry: makeGeometry(),
    // The stable six — what a selection with no contextual match gets.
    actions: resolveVisibleActions({
      types: [],
      candidate: {},
      contextualEnabled: true,
    }),
    phase: { kind: "idle" } as SelectionToolbarPhase,
    hovered: null,
    onHoverChange: () => {},
    onAction: () => {},
    onStopSpeech: () => {},
    chords: CHORDS,
    isMac: true,
    targetLocale: "zh-CN" as TargetLocale,
    localeOpen: false,
    onLocaleOpenChange: () => {},
    onLocaleSelect: () => {},
    truncated: false,
    reduceMotion: false,
  },
} satisfies Meta<typeof SelectionToolbarCapsule>

export default meta
type Story = StoryObj<typeof meta>

/** Resting state: six icons, no labels. This is what covers the user's text. */
export const Idle: Story = {}

/** Hovering expands exactly one action into its label, target and chord. */
export const HoveredCopy: Story = { args: { hovered: "copy" } }

/** Translate is the widest hover state — label + current target + chord. */
export const HoveredTranslate: Story = { args: { hovered: "translate" } }

/** Chords render as words rather than symbols away from macOS. */
export const HoveredOnWindows: Story = { args: { hovered: "remember", isMac: false } }

/** No shortcut bound (the user cleared it) — the label stands alone. */
export const HoveredWithoutChord: Story = { args: { hovered: "speak", chords: {} } }

/** Copy has fired; the checkmark holds for 420ms before the toolbar leaves. */
export const Copied: Story = { args: { phase: { kind: "ok", action: "copy" } } }

/** The memory write is in flight — every button is disabled meanwhile. */
export const RememberPending: Story = { args: { phase: { kind: "pending", action: "remember" } } }

export const RememberSaved: Story = { args: { phase: { kind: "ok", action: "remember" } } }

/**
 * The PII gate refused the write. This state is the entire reason the toolbar
 * can stay open at all: `storeExternalMemory` *returns* `{ok:false}` rather
 * than throwing, so dismissing optimistically would have made a blocked
 * memory a silent no-op.
 */
export const PiiBlocked: Story = {
  args: {
    phase: {
      kind: "error",
      action: "remember",
      reason: "Contains sensitive data — not saved to memory",
    },
  },
}

/** Speech is playing: the row morphs into a transport with a live waveform. */
export const Speaking: Story = { args: { phase: { kind: "speaking", progress: 0.42 } } }

/** Providers that report no duration still get a stop button. */
export const SpeakingWithoutProgress: Story = { args: { phase: { kind: "speaking" } } }

/** Selections over 20k characters are flagged inline. */
export const Truncated: Story = { args: { truncated: true } }

/** The language list, anchored above the capsule when the toolbar sits above. */
export const LanguageListAbove: Story = { args: { localeOpen: true } }

/**
 * When the selection is near the top of the screen Rust flips the toolbar
 * below it and pins the window's *top* edge — so the list has to open
 * downward, or the capsule would slide as the window grew.
 */
export const LanguageListBelow: Story = {
  args: { localeOpen: true, geometry: makeGeometry("below") },
}

/** Every animation collapses to a straight cut under the OS preference. */
export const ReducedMotion: Story = { args: { hovered: "explain", reduceMotion: true } }

/**
 * The one to open first: hover the icons, open the language list, click an
 * action. Wired to real state so the layout animation and the sliding
 * highlight behave exactly as they do in the product.
 */
export const Interactive: Story = {
  render: function InteractiveCapsule(args) {
    const [hovered, setHovered] = useState<SelectionActionId | null>(null)
    const [localeOpen, setLocaleOpen] = useState(false)
    const [targetLocale, setTargetLocale] = useState<TargetLocale>("zh-CN")
    const [phase, setPhase] = useState<SelectionToolbarPhase>({ kind: "idle" })

    const run = (id: SelectionActionId) => {
      setLocaleOpen(false)
      if (id === "speak") {
        setPhase({ kind: "speaking", progress: 0.35 })
        return
      }
      if (id === "remember") {
        setPhase({ kind: "pending", action: "remember" })
        window.setTimeout(() => setPhase({ kind: "ok", action: "remember" }), 900)
        window.setTimeout(() => setPhase({ kind: "idle" }), 2200)
        return
      }
      setPhase({ kind: "ok", action: id })
      window.setTimeout(() => setPhase({ kind: "idle" }), 1200)
    }

    return (
      <SelectionToolbarCapsule
        {...args}
        phase={phase}
        hovered={hovered}
        onHoverChange={setHovered}
        onAction={run}
        onStopSpeech={() => setPhase({ kind: "idle" })}
        targetLocale={targetLocale}
        localeOpen={localeOpen}
        onLocaleOpenChange={setLocaleOpen}
        onLocaleSelect={(locale) => {
          setTargetLocale(locale)
          setLocaleOpen(false)
        }}
      />
    )
  },
}

/** Every phase side by side — the fastest way to review the whole surface. */
export const AllPhases: Story = {
  decorators: [(Story) => <Story />],
  render: (args) => {
    const rows: Array<{ label: string; props: Partial<typeof args> }> = [
      { label: "Idle", props: {} },
      { label: "Hover · copy", props: { hovered: "copy" } },
      { label: "Hover · translate", props: { hovered: "translate" } },
      { label: "Copied", props: { phase: { kind: "ok", action: "copy" } } },
      { label: "Remember · pending", props: { phase: { kind: "pending", action: "remember" } } },
      {
        label: "Remember · PII blocked",
        props: {
          phase: {
            kind: "error",
            action: "remember",
            reason: "Contains sensitive data — not saved to memory",
          },
        },
      },
      { label: "Speaking", props: { phase: { kind: "speaking", progress: 0.42 } } },
      { label: "Truncated", props: { truncated: true } },
    ]
    return (
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-4">
            <span className="w-44 shrink-0 text-right text-xs text-muted-foreground">
              {row.label}
            </span>
            <OverlayWindow>
              <SelectionToolbarCapsule {...args} {...row.props} />
            </OverlayWindow>
          </div>
        ))}
      </div>
    )
  },
}

/**
 * The toolbar over real text, at both placements.
 *
 * This is the view that decides whether the icon-first layout was the right
 * call: the pill has to sit close enough to the selection to be obviously
 * about it, without covering the sentence the user is still reading. Rust
 * anchors above the selection when there is room and flips below when there
 * is not — and pins the window edge nearest the selection either way, which
 * is why the capsule does not move when the language list opens.
 */
export const InSitu: Story = {
  decorators: [(Story) => <Story />],
  render: (args) => {
    const paragraph = (
      <p className="max-w-md text-sm leading-7 text-foreground/80">
        The coordinator is intentionally native: it observes passive OS input,{" "}
        <mark className="rounded-sm bg-sky-500/30 px-0.5 text-foreground">
          reads AX/UIA selections on the automation worker
        </mark>
        , and owns the transient overlay window even while the main webview is hidden in the tray.
      </p>
    )
    return (
      <div className="flex flex-col gap-12 rounded-xl border bg-muted/30 p-8">
        <div className="flex flex-col items-center">
          <span className="mb-2 self-start text-xs font-medium text-muted-foreground">
            placement: above — window bottom pinned to the selection
          </span>
          <OverlayWindow>
            <SelectionToolbarCapsule {...args} />
          </OverlayWindow>
          {paragraph}
        </div>

        <div className="flex flex-col items-center">
          <span className="mb-2 self-start text-xs font-medium text-muted-foreground">
            placement: below — window top pinned to the selection
          </span>
          {paragraph}
          <OverlayWindow>
            <SelectionToolbarCapsule {...args} geometry={makeGeometry("below")} />
          </OverlayWindow>
        </div>
      </div>
    )
  },
}

/**
 * The defect this module was built to fix, side by side.
 *
 * Left reproduces the old geometry: a hard-coded 360×44 window with
 * `overflow: hidden`, which left 4px of margin around a 36px pill — far less
 * than `shadow-xl` needs — and 176px of transparent surplus that Rust still
 * counted as "inside the toolbar", so clicks there did nothing at all.
 * Right is the window as it is now: measured to the capsule, padded for the
 * shadow, and hit-tested against the pill itself.
 */
export const WindowGeometryBeforeAfter: Story = {
  decorators: [(Story) => <Story />],
  render: (args) => (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Before — fixed 360×44, shadow clipped, dead zone either side
        </span>
        <div
          className="relative flex h-11 w-[360px] items-center justify-center overflow-hidden outline outline-dashed outline-destructive/40"
          title="window bounds"
        >
          <div className="pointer-events-none absolute inset-y-0 left-0 w-[88px] bg-destructive/10" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-[88px] bg-destructive/10" />
          <SelectionToolbarCapsule {...args} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          After — measured to content, {SELECTION_SHADOW_PAD}px shadow padding, capsule hit-tested
        </span>
        <div className="w-max outline outline-dashed outline-emerald-500/40">
          <OverlayWindow>
            <SelectionToolbarCapsule {...args} />
          </OverlayWindow>
        </div>
      </div>
    </div>
  ),
}
