"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react"
import type { PluginContext } from "@cognia/plugin-sdk"
import {
  THINKING_LEVELS,
  clampThinkingLevel,
  definePlugin,
  definePluginManifest,
  resolveThinkingLevel,
  thinkingLevelPatch,
  type ThinkingLevel,
} from "@cognia/plugin-sdk"
import {
  effortSurfaceForSession,
  subscribeEffortSurface,
} from "@cognia/plugin-sdk/api/effort-surface"
import type { ChatInputEffortSlotContext, ExtensionProps } from "@cognia/plugin-sdk/extensions"
import { usePluginTranslations, type PluginTranslate } from "@cognia/plugin-sdk/api/i18n"
import { Button, PluginImage, Popover, PopoverContent, PopoverTrigger, cn } from "@cognia/plugin-ui"

import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)

const PLUGIN_ID = manifestJson.id

/**
 * The English strings this plugin ships, used when the host's lookup has no
 * entry for a key. The manager registers the bundle before any declarative
 * extension renders, but a control that outlives a disable (or renders in a
 * harness with no manager) would otherwise print `level.high.name` where a
 * word belongs.
 */
const ENGLISH_BUNDLE: Readonly<Record<string, string>> = manifestJson.i18n.locales.en

function interpolate(template: string, params: Parameters<PluginTranslate>[1]): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  )
}

/**
 * `usePluginTranslations` — the same lookup as `ctx.i18n.t`, re-rendering on a
 * language switch — with this plugin's own English bundle as the last resort
 * instead of the raw key.
 */
function useDialTranslations(): PluginTranslate {
  const translate = usePluginTranslations(PLUGIN_ID)
  return useCallback(
    (key, params) => {
      const value = translate(key, params)
      if (value !== key) return value
      const english = ENGLISH_BUNDLE[key]
      return english === undefined ? key : interpolate(english, params)
    },
    [translate]
  )
}

type PluginSession = NonNullable<ReturnType<PluginContext["session"]["getCurrentSession"]>>

/**
 * The host context, published as a tiny store rather than a bare `let`.
 *
 * The composer's `chat.input.effort` slot can mount this control before the
 * plugin manager has run `activate`, and `deactivate` can null the context out
 * from under a mounted one. A component that read the variable once would sit
 * there permanently disabled with nothing that could ever wake it, so the
 * assignment is a publish and the control subscribes to it.
 */
let pluginContext: PluginContext | null = null
const contextListeners = new Set<() => void>()

function publishPluginContext(next: PluginContext | null): void {
  if (pluginContext === next) return
  pluginContext = next
  for (const listener of [...contextListeners]) listener()
}

function subscribePluginContext(listener: () => void): () => void {
  contextListeners.add(listener)
  return () => {
    contextListeners.delete(listener)
  }
}

function getPluginContext(): PluginContext | null {
  return pluginContext
}

/** A prerender has no host context, and must not hydrate into one. */
function getPluginContextServerSnapshot(): PluginContext | null {
  return null
}

/** Stable identities, so the subscriptions below do not re-arm every render. */
const NOOP_UNSUBSCRIBE = () => undefined
const getNoSession = (): PluginSession | null => null

function usePluginRuntime() {
  const ctx = useSyncExternalStore(
    subscribePluginContext,
    getPluginContext,
    getPluginContextServerSnapshot
  )

  // Both subscriptions are keyed on `ctx`, so a context that arrives after
  // mount re-arms them and the control comes alive instead of staying inert for
  // the rest of the session. `getCurrentSession` hands back the host store's
  // own row, whose identity is stable until that row changes, which is what
  // makes it a legal snapshot.
  const session = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => (ctx ? ctx.session.onSessionChange(onChange) : NOOP_UNSUBSCRIBE),
      [ctx]
    ),
    useCallback(() => ctx?.session.getCurrentSession() ?? null, [ctx]),
    getNoSession
  )

  return { ctx, session }
}

/** The slot context the composer passes (`ChatInputEffortSlotContext`), read defensively. */
function readSlotContext(context: ExtensionProps["context"]): Partial<ChatInputEffortSlotContext> {
  if (!context) return {}
  return {
    sessionId: typeof context.sessionId === "string" ? context.sessionId : undefined,
    disabled: context.disabled === true,
    compact: context.compact === true,
  }
}

/**
 * The session of the composer this dial sits in. Usually that is the focused
 * session; when the slot names a different one (a split view, a detached
 * composer) its row is fetched and kept fresh on every session change, so the
 * dial never writes a depth into a conversation the user is not typing in.
 */
function useSlotSession(
  ctx: PluginContext | null,
  focused: PluginSession | null,
  slotSessionId: string | undefined
): PluginSession | null {
  const [slotRow, setSlotRow] = useState<PluginSession | null>(null)
  const needsLookup = Boolean(ctx && slotSessionId && focused?.id !== slotSessionId)
  useEffect(() => {
    if (!ctx || !slotSessionId || !needsLookup) return
    let alive = true
    const load = () => {
      void ctx.session.getSession(slotSessionId).then((row) => {
        if (alive) setSlotRow((row as PluginSession | null) ?? null)
      })
    }
    load()
    const unsubscribe = ctx.session.onSessionChange(load)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [ctx, slotSessionId, needsLookup])
  if (!slotSessionId || !needsLookup) return focused
  return slotRow?.id === slotSessionId ? slotRow : null
}

export function AnimeEffortControl({ pluginId, context }: ExtensionProps) {
  const { ctx, session: focusedSession } = usePluginRuntime()
  const slot = readSlotContext(context)
  const session = useSlotSession(ctx, focusedSession, slot.sessionId)
  // The host chip this dial replaces is disabled while a reply streams; a
  // depth changed mid-turn would apply to a turn that already started.
  const streaming = slot.disabled === true
  const [pending, setPending] = useState<ThinkingLevel | null>(null)
  // Strings come from the plugin's own bundle, not the context: the control can
  // render before `activate` publishes one, and must not show raw keys then.
  const t = useDialTranslations()
  const radioRefs = useRef(new Map<ThinkingLevel, HTMLButtonElement>())

  // The host's own answer, not a second derivation of it. Which tiers to offer
  // depends on four things this row does not carry (the runtime lane executing
  // the turn, the app-level model/provider defaults behind an unpinned session,
  // whether the model reasons at all, and the user's hidden-tier preference),
  // so re-deriving it here would put a different ladder in this panel from the
  // one in the host's chip two buttons away.
  //
  // Read out before the memo so the declared dependencies are exactly what the
  // body touches. A `session?.x` dependency reads as the whole row.
  const sessionId = session?.id
  const modelId = session?.model
  const providerOverride = session?.providerOverride
  // Four of the five inputs (the fifth being the external agent's own published
  // ladder) live in host stores, not on the row, so the row alone is not a
  // dependency list. Without this the dial keeps offering
  // `xhigh`/`max`/`ultracode` after the conversation moves to an external agent
  // whose real ladder is `low | medium | high`, and writes a depth that agent
  // folds away. `subscribeEffortSurface` fires only when one of them would
  // change the answer, so an unrelated settings write costs nothing.
  const [surfaceEpoch, setSurfaceEpoch] = useState(0)
  useEffect(
    () => subscribeEffortSurface(sessionId, () => setSurfaceEpoch((value) => value + 1)),
    [sessionId]
  )
  const offered = useMemo(() => {
    // Read so the dependency is a real one. The epoch carries no value of its
    // own, it stands in for the three inputs the host holds and this row does
    // not, which are reached through `effortSurfaceForSession` below.
    void surfaceEpoch
    return effortSurfaceForSession(
      sessionId ? { id: sessionId, model: modelId, providerOverride } : null
    ).levels
  }, [sessionId, modelId, providerOverride, surfaceEpoch])

  // `off` is not a depth. It is the way back to the model's own default, so it
  // heads the list whenever the surface has any depth control at all.
  const levels: ThinkingLevel[] = offered.length > 0 ? ["off", ...offered] : []

  // Display the tier the NEXT turn will really use: a persisted level this
  // surface cannot honour folds down to the deepest one it can.
  const level = clampThinkingLevel(pending ?? resolveThinkingLevel(session), offered)
  const usable = Boolean(ctx && session && levels.length > 0 && !streaming)
  // An `aria-label` REPLACES the element's text for assistive tech, and the
  // visible label deliberately pairs the caption with the live tier. Naming only
  // the caption would drop the half that carries the value, leaving a
  // screen-reader user unable to tell Standby from Singularity without opening
  // the panel.
  const triggerLabel = !session
    ? t("control.unavailable")
    : levels.length === 0
      ? t("control.unsupported")
      : t("control.aria", { level: t(`level.${level}.name`) })

  // One tab stop for the whole group (a radio group is ONE control): the
  // checked tier, or the first one if the checked tier is not on offer.
  const tabStop = levels.includes(level) ? level : levels[0]

  const selectLevel = async (next: ThinkingLevel) => {
    if (!ctx || !session || pending || streaming) return
    setPending(next)
    try {
      // `thinkingLevelPatch` rather than a hand-written pair: `effort` is what
      // every existing consumer reads and `thinkingLevel` is the tier identity
      // it cannot express, and the two are only guaranteed to agree because one
      // function writes both.
      await ctx.session.updateSession(session.id, thinkingLevelPatch(next))
      ctx.ui.showToast(t("panel.success", { level: t(`level.${next}.name`) }), "success")
    } catch (error) {
      ctx.logger.error("Failed to update thinking intensity", error)
      ctx.ui.showToast(t("panel.error"), "error")
    } finally {
      setPending(null)
    }
  }

  // Arrow keys move the checked tier, the WAI-ARIA radio-group contract (focus
  // and selection travel together). Ignored while a write is in flight, so the
  // focused radio and the checked one never disagree.
  const onRadioKeyDown = (event: KeyboardEvent<HTMLButtonElement>, item: ThinkingLevel) => {
    const index = levels.indexOf(item)
    let nextIndex: number
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = (index + 1) % levels.length
        break
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = (index - 1 + levels.length) % levels.length
        break
      case "Home":
        nextIndex = 0
        break
      case "End":
        nextIndex = levels.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    if (!session || pending || streaming) return
    const next = levels[nextIndex]
    radioRefs.current.get(next)?.focus()
    if (next !== level) void selectLevel(next)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!usable}
          aria-label={triggerLabel}
          title={t("control.label")}
          className="aef-trigger touch-hit"
          data-level={level}
          // Folded toolbar: the host chip shrinks to a glyph, so the dial does
          // too (the value moves to the tooltip / accessible name).
          data-compact={slot.compact || undefined}
        >
          {/* One line, glyph then value, the shape of every other chip on the
              composer row where this control stands in for the host's effort
              chip. The caption moved to the tooltip: a stacked two-line
              uppercase label was the one control there that did not read as a
              chip. */}
          <span className="aef-trigger-mark" aria-hidden>
            <span />
          </span>
          {slot.compact ? null : (
            <strong className="aef-trigger-value">{t(`level.${level}.name`)}</strong>
          )}
        </Button>
      </PopoverTrigger>

      {/* `PopoverContent` portals to `document.body`, outside the slot wrapper
          that carries the scope root, and plugin CSS is wrapped in
          `@scope ([data-plugin-root="<id>"])`. Without re-stamping it here every
          rule below `.aef-panel` is out of scope and silently drops. */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        className="aef-panel"
        data-plugin-root={pluginId}
      >
        <div className="aef-hero" data-level={level}>
          <PluginImage
            // `public/illustrations/`, the app's committed static-artwork
            // namespace, rather than `public/plugins/`. That path reads as the
            // plugin ROOT convention (`/plugins/<id>`, what `pluginPath`
            // carries) and as the `app/plugins/` route, and this is neither.
            // The builtin-asset pipeline under `/_cognia/builtin-plugins/` is
            // not the home for it either: that tree is gitignored, wiped on
            // every build, and generated only for the five asset-delivered
            // builtins. This plugin is statically imported.
            src="/illustrations/cognia-anime-effort/operator.webp"
            alt={t("panel.operatorAlt")}
            className="aef-operator"
          />
          <div className="aef-grid" aria-hidden />
          <div className="aef-hero-copy">
            <span>{t("panel.eyebrow")}</span>
            <h3>{t("panel.title")}</h3>
            <p>{t("panel.subtitle")}</p>
          </div>
          <div className="aef-signal" aria-hidden>
            {levels.map((item, index) => (
              <span key={item} data-active={index <= levels.indexOf(level)} />
            ))}
          </div>
        </div>

        <div
          className="aef-levels"
          role="radiogroup"
          aria-label={t("panel.levelAria")}
          aria-busy={pending !== null}
        >
          {levels.map((item) => {
            const active = item === level
            // Numbered by the tier's place in the FULL vocabulary, so the badge
            // keeps agreeing with the `level.<id>.code` string next to it when
            // the surface narrows the ladder.
            const index = THINKING_LEVELS.indexOf(item)
            return (
              <button
                key={item}
                ref={(node) => {
                  if (node) radioRefs.current.set(item, node)
                  else radioRefs.current.delete(item)
                }}
                type="button"
                role="radio"
                aria-checked={active}
                // `aria-disabled` rather than `disabled` while a write is in
                // flight: a disabled button drops keyboard focus to <body>.
                aria-disabled={pending !== null || undefined}
                disabled={!session}
                tabIndex={item === tabStop ? 0 : -1}
                onClick={() => void selectLevel(item)}
                onKeyDown={(event) => onRadioKeyDown(event, item)}
                className={cn("aef-level", active && "aef-level--active")}
                data-level={item}
              >
                <span className="aef-index">{String(index).padStart(2, "0")}</span>
                <span className="aef-level-copy">
                  <span className="aef-level-heading">
                    <strong>{t(`level.${item}.name`)}</strong>
                    <small>{t(`level.${item}.code`)}</small>
                  </span>
                  <span>{t(`level.${item}.desc`)}</span>
                </span>
                <span className="aef-state" data-syncing={active && pending !== null}>
                  {active ? t(pending ? "panel.applying" : "panel.current") : ""}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export const ANIME_EFFORT_CSS = String.raw`
/* Theme hooks, declared on BOTH roots: the trigger renders inside the composer
   slot, the panel inside a portal that re-stamps the scope root itself.
   The accent tracks the host's own deepest-effort token instead of a literal,
   so the control follows the palette and the style pack like its neighbours.
   The plate and its ink are deliberately fixed: they sit over artwork rather
   than over the theme surface, so they must stay legible in both themes. */
:where(.aef-trigger, .aef-panel) {
  --aef-accent: var(--effort-ultra);
  --aef-plate: oklch(.22 .021 249);
  --aef-ink: oklch(.97 .004 249);
}
.aef-trigger[data-compact] {
  /* Folded toolbar: the host dropped the declared width box, so the trigger
     sizes to its glyph like the host's own folded chip. */
  width: auto;
  padding: 0 .375rem;
}
.aef-trigger {
  height: 1.75rem;
  /* The surface hands this control a fixed-width box, not a measurement —
     fill it and no further, or a content-sized trigger paints past its right
     edge over the next toolbar control. */
  width: 100%;
  min-width: 0;
  gap: .45rem;
  border-radius: var(--radius-control);
  padding: 0 .5rem;
  color: var(--muted-foreground);
  font-size: 11px;
  font-weight: 400;
}
/* Hover styling only where a pointer can hover: on touch the hover state
   sticks to the last tapped element and reads as a second, phantom selection. */
@media (hover: hover) {
  .aef-trigger:hover { color: var(--foreground); }
  .aef-level:not([aria-disabled="true"]):hover {
    background: color-mix(in oklab, var(--foreground) 6%, transparent);
    color: var(--foreground);
  }
}
.aef-trigger-mark {
  position: relative;
  display: grid;
  width: .65rem;
  height: .65rem;
  flex: none;
  place-items: center;
  transform: rotate(45deg);
  border: 1px solid color-mix(in oklab, var(--primary) 70%, transparent);
  background: color-mix(in oklab, var(--primary) 10%, transparent);
}
.aef-trigger-mark::before,
.aef-trigger-mark::after,
.aef-trigger-mark span {
  content: "";
  position: absolute;
  width: 1.5px;
  background: var(--primary);
}
.aef-trigger-mark::before { height: 26%; }
.aef-trigger-mark span { height: 48%; transform: translateX(-2px); }
.aef-trigger-mark::after { height: 76%; transform: translateX(2px); }
.aef-trigger[data-level="ultracode"] .aef-trigger-mark {
  border-color: var(--aef-accent);
  box-shadow: 0 0 12px color-mix(in oklab, var(--aef-accent) 45%, transparent);
}
.aef-trigger-value {
  /* A flex item's floor is its own content — without this the label holds
     the trigger open past the surface instead of reaching the ellipsis. */
  min-width: 0;
  max-width: 6rem;
  overflow: hidden;
  font-weight: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aef-panel {
  display: flex;
  width: min(25rem, calc(100vw - 1rem));
  /* Never taller than the space the popover actually has (Radix publishes it
     on the content element), so on a short or phone-sized window the tier
     list scrolls inside the panel instead of running off-screen. */
  max-height: min(36rem, var(--radix-popover-content-available-height, calc(100dvh - 2rem)));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in oklab, var(--foreground) 16%, transparent);
  border-radius: var(--radius-panel);
  padding: 0;
  background: color-mix(in oklab, var(--popover) 96%, var(--aef-plate));
  box-shadow: 0 22px 60px rgb(0 0 0 / .32);
}
.aef-hero {
  position: relative;
  flex: none;
  height: 10.5rem;
  overflow: hidden;
  border-bottom: 1px solid color-mix(in oklab, var(--aef-accent) 25%, transparent);
  background: var(--aef-plate);
  isolation: isolate;
}
.aef-operator {
  position: absolute;
  inset: 0 0 0 auto;
  z-index: -2;
  width: 72%;
  height: 100%;
  max-height: none;
  border: 0;
  border-radius: 0;
  object-fit: cover;
  object-position: 66% 24%;
  filter: saturate(.78) contrast(1.05);
}
.aef-hero::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(90deg, var(--aef-plate) 0 37%, color-mix(in oklab, var(--aef-plate) 86%, transparent) 52%, transparent 78%);
}
.aef-grid {
  position: absolute;
  inset: 0;
  opacity: .18;
  background-image: linear-gradient(color-mix(in oklab, var(--aef-accent) 45%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, var(--aef-accent) 45%, transparent) 1px, transparent 1px);
  background-size: 16px 16px;
  mask-image: linear-gradient(90deg, #000, transparent 70%);
}
.aef-hero-copy {
  position: absolute;
  inset: 1.15rem auto auto 1rem;
  width: 56%;
  color: var(--aef-ink);
}
.aef-hero-copy > span {
  color: var(--aef-accent);
  font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .14em;
}
.aef-hero-copy h3 {
  margin: .55rem 0 .4rem;
  font: 800 1.22rem/.96 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -.04em;
  text-transform: uppercase;
}
.aef-hero-copy p {
  margin: 0;
  color: color-mix(in oklab, var(--aef-ink) 72%, transparent);
  font-size: 11px;
  line-height: 1.45;
}
.aef-signal {
  position: absolute;
  bottom: .8rem;
  left: 1rem;
  display: flex;
  align-items: end;
  gap: 3px;
}
.aef-signal span {
  width: 4px;
  background: color-mix(in oklab, var(--aef-ink) 18%, transparent);
}
.aef-signal span:nth-child(1) { height: 4px; }
.aef-signal span:nth-child(2) { height: 6px; }
.aef-signal span:nth-child(3) { height: 8px; }
.aef-signal span:nth-child(4) { height: 10px; }
.aef-signal span:nth-child(5) { height: 12px; }
.aef-signal span:nth-child(6) { height: 14px; }
.aef-signal span:nth-child(7) { height: 16px; }
.aef-signal span[data-active="true"] {
  background: var(--aef-accent);
  box-shadow: 0 0 7px color-mix(in oklab, var(--aef-accent) 55%, transparent);
}
.aef-levels {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: .45rem;
}
.aef-level {
  display: grid;
  width: 100%;
  grid-template-columns: 1.75rem minmax(0, 1fr) auto;
  gap: .5rem;
  align-items: center;
  border: 0;
  border-left: 2px solid transparent;
  border-radius: var(--radius-sm);
  padding: .5rem .45rem;
  background: transparent;
  color: var(--muted-foreground);
  text-align: left;
  transition: background-color 120ms ease-out, color 120ms ease-out;
}
.aef-level:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.aef-level[aria-disabled="true"] { cursor: progress; }
.aef-level--active {
  border-left-color: var(--aef-accent);
  background: linear-gradient(90deg, color-mix(in oklab, var(--aef-accent) 12%, transparent), transparent 72%);
  color: var(--foreground);
}
.aef-index {
  color: color-mix(in oklab, var(--aef-accent) 76%, var(--muted-foreground));
  font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.aef-level-copy { display: flex; min-width: 0; flex-direction: column; gap: .18rem; }
.aef-level-heading { display: flex; min-width: 0; align-items: baseline; gap: .45rem; }
.aef-level-heading strong { color: inherit; font-size: 12px; line-height: 1.1; }
.aef-level-heading small {
  overflow: hidden;
  color: color-mix(in oklab, var(--muted-foreground) 72%, transparent);
  font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .04em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aef-level-copy > span:last-child {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aef-state {
  color: var(--aef-accent);
  font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
}
/* Touch: every tier row clears the 36px minimum target (the trigger gets the
   host's own \`touch-hit\` expansion, like every other composer chip). */
@media (pointer: coarse) {
  .aef-level { min-height: 2.75rem; }
}
/* Short windows (landscape phones, a docked desktop window): shrink the art
   first, then drop it, so the tiers — the actual control — keep the room. */
@media (max-height: 600px) {
  .aef-hero { height: 7rem; }
  .aef-hero-copy p { display: none; }
}
@media (max-height: 420px) {
  .aef-hero { display: none; }
}
/* Top level on purpose. The stylesheet is wrapped in @scope before injection,
   and only TOP-LEVEL keyframes are hoisted back out of it. Left inside the
   media query this name would be dropped and the animation below would
   reference nothing. */
@keyframes aef-pulse { 50% { opacity: .45; } }
/* A progress cue, not decoration: it runs only while the tier write is in
   flight, and not at all for a user who asked for reduced motion. */
@media (prefers-reduced-motion: no-preference) {
  .aef-state[data-syncing="true"] { animation: aef-pulse 1.2s ease-in-out infinite; }
}
`

export default definePlugin({
  manifest,
  activate: (context) => {
    publishPluginContext(context)
  },
  deactivate: () => {
    publishPluginContext(null)
  },
})
