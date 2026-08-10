import { ClassValue } from "clsx"
import * as React from "react"
import {
  Accordion as Accordion$1,
  Avatar as Avatar$1,
  Checkbox as Checkbox$1,
  Collapsible as Collapsible$1,
  Dialog as Dialog$1,
  ContextMenu as ContextMenu$1,
  DropdownMenu as DropdownMenu$1,
  HoverCard as HoverCard$1,
  Label as Label$1,
  Slot,
  Popover as Popover$1,
  Progress as Progress$1,
  RadioGroup as RadioGroup$1,
  ScrollArea as ScrollArea$1,
  Select as Select$1,
  Separator as Separator$1,
  Slider as Slider$1,
  Switch as Switch$1,
  Tabs as Tabs$1,
  Tooltip as Tooltip$1,
} from "radix-ui"
import * as class_variance_authority_types from "class-variance-authority/types"
import { VariantProps } from "class-variance-authority"
import { Command as Command$1 } from "cmdk"
import * as react_hook_form from "react-hook-form"
import { FieldValues, FieldPath, ControllerProps } from "react-hook-form"
import { ToasterProps } from "sonner"
export { toast } from "sonner"

/**
 * Class-name merger, identical in behavior to the host's `@/lib/utils` `cn`.
 * Duplicated rather than imported because this package must resolve with zero
 * `@/` app paths — see the note in README.md on why the fork is deliberate.
 */
declare function cn(...inputs: ClassValue[]): string

/**
 * Stacked disclosure list.
 *
 * The body's open/close has to be a real CSS `@keyframes` animation, not a
 * transition and not a JS one: Radix's `Presence` keeps exiting content mounted
 * only while `getComputedStyle(node).animationName !== "none"`, so anything
 * else is torn out of the DOM before it can play. `animate-accordion-up` /
 * `animate-accordion-down` are those keyframes, published by `tw-animate-css`
 * at the app layer — the same dependency `select`, `tooltip`, `popover`,
 * `dropdown-menu`, `context-menu`, `hover-card` and `sheet` in this package
 * already carry. Keeping it here is what preserves Radix's `hidden` semantics:
 * a collapsed region leaves the accessibility tree entirely rather than
 * lingering as an empty labelled landmark.
 */
declare function Accordion({
  ...props
}: React.ComponentProps<typeof Accordion$1.Root>): React.JSX.Element
declare function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof Accordion$1.Item>): React.JSX.Element
declare function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Accordion$1.Trigger>): React.JSX.Element
/**
 * The caller's `className` lands on the inner padding div, not on the animated
 * element: the keyframes interpolate that element's height under a clip, so
 * padding or a border applied there would be sheared off mid-animation instead
 * of growing with it.
 */
declare function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Accordion$1.Content>): React.JSX.Element

declare const alertVariants: (
  props?:
    | ({
        variant?: "default" | "destructive" | null | undefined
      } & class_variance_authority_types.ClassProp)
    | undefined
) => string
declare function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>): React.JSX.Element
declare function AlertTitle({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element
declare function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element

/**
 * Identity chip.
 *
 * Built on Radix rather than a bare `<img>` because the interesting part is the
 * load state machine: `AvatarImage` only reveals itself once the network fetch
 * resolves, so the fallback never flashes behind a cached image and never
 * disappears behind a broken URL. A plugin rendering avatars from arbitrary
 * remote sources (a connector's contact list, a git author) gets that for free.
 *
 * `size` is a data attribute rather than a prop threaded through every part:
 * the fallback, the badge and the group count all size themselves off the
 * `group/avatar` container, so a caller sets one prop and the whole cluster
 * scales together.
 */
declare function Avatar({
  className,
  size,
  ...props
}: React.ComponentProps<typeof Avatar$1.Root> & {
  size?: "default" | "sm" | "lg"
}): React.JSX.Element
declare function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof Avatar$1.Image>): React.JSX.Element
/**
 * Rendered until (and unless) the image loads. Its content is the caller's —
 * initials, an icon, whatever the plugin can compute without a network round
 * trip — because the kit has no way to derive a label from a locale it cannot
 * read.
 */
declare function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof Avatar$1.Fallback>): React.JSX.Element
/**
 * Status dot / mini-icon pinned to the avatar's corner. Purely decorative by
 * default: at `sm` the slot is too small to render a glyph legibly, so any
 * `<svg>` inside is hidden rather than squashed — meaning a caller that encodes
 * meaning here must also convey it in text.
 */
declare function AvatarBadge({
  className,
  ...props
}: React.ComponentProps<"span">): React.JSX.Element
declare function AvatarGroup({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element
/**
 * The "+3" tail of an `AvatarGroup`. It sizes off `group-has-data-[size=…]`,
 * i.e. off whatever the sibling avatars declared, so the overflow chip cannot
 * drift out of alignment when a caller changes the group's avatar size.
 */
declare function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element

declare const badgeVariants: (
  props?:
    | ({
        variant?:
          | "link"
          | "default"
          | "destructive"
          | "secondary"
          | "success"
          | "warning"
          | "outline"
          | "ghost"
          | null
          | undefined
      } & class_variance_authority_types.ClassProp)
    | undefined
) => string
declare function Badge({
  className,
  variant,
  asChild,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
  }): React.JSX.Element

declare const buttonVariants: (
  props?:
    | ({
        variant?:
          "link" | "default" | "destructive" | "secondary" | "outline" | "ghost" | null | undefined
        size?:
          | "default"
          | "sm"
          | "lg"
          | "xs"
          | "icon"
          | "icon-xs"
          | "icon-sm"
          | "icon-lg"
          | null
          | undefined
      } & class_variance_authority_types.ClassProp)
    | undefined
) => string
declare function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }): React.JSX.Element

declare function Card({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element
declare function CardHeader({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element
declare function CardTitle({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element
declare function CardDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element
declare function CardAction({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element
declare function CardContent({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element
declare function CardFooter({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element

declare function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof Checkbox$1.Root>): React.JSX.Element

/**
 * Show/hide region with the trigger ⇄ content ARIA wiring already done
 * (`aria-controls`, `aria-expanded`, and an id the caller never has to mint).
 *
 * Deliberately unstyled and unanimated, exactly as in the host: a collapsible
 * is a behavior, not a look, and every call site wants a different one. Note
 * that Radix drops the content from the DOM while closed unless `forceMount` is
 * set — assert on visibility, not on class names, and remember that a closed
 * region's focusable descendants genuinely do not exist.
 *
 * Animating it is the caller's choice, and the constraint worth knowing first
 * is that Radix defers an exit only for a real CSS `@keyframes` animation — a
 * transition is not detected, and the content is gone before it can play. So
 * either give the content keyframes (what `./accordion` does), or take presence
 * yourself with `forceMount` and wrap the body in `Collapse` from `./motion`.
 */
declare function Collapsible({
  ...props
}: React.ComponentProps<typeof Collapsible$1.Root>): React.JSX.Element
declare function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof Collapsible$1.CollapsibleTrigger>): React.JSX.Element
declare function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof Collapsible$1.CollapsibleContent>): React.JSX.Element

/**
 * Modal dialog.
 *
 * Portals to `document.body`, which puts it outside the `[data-plugin-root]`
 * subtree a plugin's scoped stylesheet is bound to — so a dialog is styled by
 * this kit's classes and by nothing the plugin wrote. Compose it from the
 * exported parts rather than styling `DialogContent` into a new shape; the
 * overlay, the focus trap and the escape handling all come from the parts.
 */
declare function Dialog(props: React.ComponentProps<typeof Dialog$1.Root>): React.JSX.Element
declare function DialogTrigger(
  props: React.ComponentProps<typeof Dialog$1.Trigger>
): React.JSX.Element
declare function DialogClose(props: React.ComponentProps<typeof Dialog$1.Close>): React.JSX.Element
declare function DialogPortal(
  props: React.ComponentProps<typeof Dialog$1.Portal>
): React.JSX.Element
declare function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof Dialog$1.Overlay>): React.JSX.Element
/**
 * The dialog panel, with its own portal and overlay — do not nest it in a
 * `DialogPortal` yourself.
 *
 * `closeLabel` is required rather than defaulted to "Close": this package ships
 * no message catalog and a plugin's UI is localized by the plugin, so a default
 * here would hard-code English into every locale. `forceMount` is threaded to
 * the portal and overlay as well, so mounting the content also mounts the
 * scrim it is measured against.
 */
declare function DialogContent({
  className,
  children,
  showCloseButton,
  closeLabel,
  forceMount,
  ...props
}: React.ComponentProps<typeof Dialog$1.Content> & {
  showCloseButton?: boolean
  /** Localized accessible name for the close control. */
  closeLabel: string
}): React.JSX.Element
declare function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element
/**
 * Action row. `showCloseButton` adds a trailing dismiss button after the
 * caller's own actions — opt-in, because a footer whose only action is "Close"
 * duplicates the corner control `DialogContent` already renders.
 */
declare function DialogFooter({
  className,
  showCloseButton,
  closeLabel,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
  /** Localized text for the optional footer close button. */
  closeLabel: string
}): React.JSX.Element
/**
 * Required by Radix for the dialog's accessible name. Omitting it leaves the
 * dialog unlabelled and logs a development warning — render it inside
 * `DialogHeader`, or visually hide it if the design has no visible heading.
 */
declare function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof Dialog$1.Title>): React.JSX.Element
declare function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof Dialog$1.Description>): React.JSX.Element

/**
 * Filterable command list (cmdk), styled to the host's popover tokens.
 *
 * Deliberately INLINE-ONLY. The host's copy also ships a `CommandDialog`
 * variant that wraps the list in a centered modal; that is not ported here:
 *
 *  - plugin-ui has no `Dialog`, and is not getting one. Centered modals are
 *    already the runtime's job via `ctx.modal.openModal()`, which the host
 *    mounts, sizes and dismisses. A second, plugin-rendered modal stack would
 *    be a competing way to do the same thing with different focus/escape
 *    semantics.
 *  - a plugin that wants a command palette in a modal composes the two:
 *    `ctx.modal.openModal()` for the container, `<Command>` for the contents.
 *
 * For an edge-anchored container use `Sheet` from this same package.
 *
 * cmdk is a peerDependency resolved from the host at plugin load time (same
 * shared-instance rule as react/radix-ui), so nothing here is bundled twice.
 */
declare function Command({
  className,
  ...props
}: React.ComponentProps<typeof Command$1>): React.JSX.Element
declare function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof Command$1.Input>): React.JSX.Element
declare function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof Command$1.List>): React.JSX.Element
/**
 * Renders only while cmdk's filter matches nothing. The caller supplies the
 * copy as children — this package never ships user-facing text, because a
 * plugin's strings have to come from the plugin's own locale bundle.
 */
declare function CommandEmpty({
  ...props
}: React.ComponentProps<typeof Command$1.Empty>): React.JSX.Element
declare function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof Command$1.Group>): React.JSX.Element
declare function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Command$1.Separator>): React.JSX.Element
declare function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof Command$1.Item>): React.JSX.Element
declare function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">): React.JSX.Element

/**
 * Right-click context menu — the third anchored overlay a plugin cannot build
 * for itself.
 *
 * Same constraint as `dropdown-menu.tsx` / `popover.tsx`: no `react-dom` in the
 * plugin's module graph means no `createPortal`, so the host has to own the
 * layer. What is specific here is the anchor: a context menu positions against
 * the *pointer*, not against a trigger box, so `ContextMenuTrigger` wraps the
 * region a plugin wants to make right-clickable and Radix tracks the event
 * coordinates itself. The part families below are the same menu primitives as
 * `DropdownMenu` (Radix shares an internal `Menu`), so an author who learned
 * one already knows the other.
 */

declare function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Root>): React.JSX.Element
/**
 * Wraps the right-clickable region. Unlike a dropdown trigger this renders a
 * `<span>` (a plain block by default), not a button — it is a hit area, not a
 * control, and giving it button semantics would put it in the tab order and
 * announce a press affordance that does nothing.
 */
declare function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Trigger>): React.JSX.Element
declare function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Group>): React.JSX.Element
/**
 * `Content` already portals; this is only for the rare case of needing a second
 * portal boundary (see the same note on `DropdownMenuPortal`).
 */
declare function ContextMenuPortal({
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Portal>): React.JSX.Element
declare function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Sub>): React.JSX.Element
declare function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenu$1.RadioGroup>): React.JSX.Element
declare function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenu$1.SubTrigger> & {
  inset?: boolean
}): React.JSX.Element
declare function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenu$1.SubContent>): React.JSX.Element
declare function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Content>): React.JSX.Element
declare function ContextMenuItem({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}): React.JSX.Element
declare function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenu$1.CheckboxItem>): React.JSX.Element
declare function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenu$1.RadioItem>): React.JSX.Element
declare function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Label> & {
  inset?: boolean
}): React.JSX.Element
declare function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenu$1.Separator>): React.JSX.Element
/**
 * Right-aligned accelerator hint. Plain `<span>` with no role so the text stays
 * out of the item's accessible name.
 */
declare function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">): React.JSX.Element

/**
 * Anchored dropdown menu — the sanctioned way a plugin opens a menu.
 *
 * `react-dom` is deliberately absent from the host's shared-module whitelist
 * (`lib/plugin/core/shared-modules.ts`), so a plugin has no `createPortal` and
 * therefore cannot build any overlay of its own: everything it renders is
 * trapped inside its slot and its `@scope`d stylesheet. That trap is the point
 * — it is also why "toolbar icon opens a menu", the single most common plugin
 * UI shape, is impossible without this file. Radix's own Portal is imported by
 * the HOST, not the plugin, so the host stays the one deciding where the layer
 * lands and when it unmounts; the plugin only supplies children.
 */

declare function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Root>): React.JSX.Element
/**
 * Exposed so a caller can co-locate content with a distant trigger. `Content`
 * already portals on its own — reach for this only when you need a second
 * portal boundary (e.g. rendering a menu from inside an `overflow:hidden`
 * ancestor that is NOT the trigger).
 */
declare function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Portal>): React.JSX.Element
declare function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Trigger>): React.JSX.Element
declare function DropdownMenuContent({
  className,
  sideOffset,
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Content>): React.JSX.Element
declare function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Group>): React.JSX.Element
declare function DropdownMenuItem({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}): React.JSX.Element
declare function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.CheckboxItem>): React.JSX.Element
declare function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.RadioGroup>): React.JSX.Element
declare function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.RadioItem>): React.JSX.Element
declare function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Label> & {
  inset?: boolean
}): React.JSX.Element
declare function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Separator>): React.JSX.Element
/**
 * Right-aligned accelerator hint. Plain `<span>`, not a Radix part — Radix has
 * no shortcut primitive and the text must stay out of the item's accessible
 * name, which `ml-auto` plus no role achieves.
 */
declare function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">): React.JSX.Element
declare function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.Sub>): React.JSX.Element
declare function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.SubTrigger> & {
  inset?: boolean
}): React.JSX.Element
declare function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenu$1.SubContent>): React.JSX.Element

/**
 * Pointer-triggered preview card.
 *
 * Like every layered component in this kit, it exists because a plugin has no
 * `react-dom` (see `lib/plugin/core/shared-modules.ts`) and therefore no
 * `createPortal`: without a host-provided primitive, plugin content could not
 * escape its slot's overflow/stacking context and a preview would be clipped.
 * Radix's own portal is used here — the host mounts and controls it.
 *
 * Hover-only by design: Radix deliberately does NOT open a HoverCard on
 * keyboard focus or touch, so it must never carry information available
 * nowhere else. Use `Tooltip` for a label, `Sheet` for content that must be
 * reachable by every input method.
 */
declare function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCard$1.Root>): React.JSX.Element
declare function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCard$1.Trigger>): React.JSX.Element
declare function HoverCardContent({
  className,
  align,
  sideOffset,
  ...props
}: React.ComponentProps<typeof HoverCard$1.Content>): React.JSX.Element

declare function Input({
  className,
  type,
  ...props
}: React.ComponentProps<"input">): React.JSX.Element

declare function Label({
  className,
  ...props
}: React.ComponentProps<typeof Label$1.Root>): React.JSX.Element

/**
 * Form context provider — `react-hook-form`'s `FormProvider` under this name.
 *
 * The kit deliberately owns only the *wiring* (ids, `aria-describedby`,
 * `aria-invalid`, error text) and never the form state: a plugin brings its own
 * `useForm()` and its own resolver, so validation rules and their messages stay
 * in the plugin's language and locale. Spread the `useForm()` return into this
 * provider, then build fields from `FormField` → `FormItem` → `FormLabel` /
 * `FormControl` / `FormDescription` / `FormMessage`.
 */
declare const Form: <
  TFieldValues extends FieldValues,
  TContext = any,
  TTransformedValues = TFieldValues,
>({
  children,
  watch,
  getValues,
  getFieldState,
  setError,
  clearErrors,
  setValue,
  setValues,
  trigger,
  formState,
  resetField,
  reset,
  resetDefaultValues,
  handleSubmit,
  unregister,
  control,
  register,
  setFocus,
  subscribe,
}: react_hook_form.FormProviderProps<
  TFieldValues,
  TContext,
  TTransformedValues
>) => React.JSX.Element
/**
 * Binds one field name to the surrounding form. Publishes that name on context
 * so `FormLabel` / `FormControl` / `FormMessage` can find the field's state
 * without being handed it — which is what keeps a field's markup free of prop
 * threading.
 */
declare function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>): React.JSX.Element
/**
 * The current field's id triplet plus its `react-hook-form` state, for building
 * a control the kit does not ship.
 *
 * Throws outside `<FormField>` / `<FormItem>` instead of degrading: the ids it
 * returns are what wire a label to its input and an error to `aria-describedby`,
 * so a silent fallback would produce a field that looks right and is unusable
 * with a screen reader.
 */
declare function useFormField(): {
  invalid: boolean
  isDirty: boolean
  isTouched: boolean
  isValidating: boolean
  error?: react_hook_form.FieldError
  id: string
  name: string
  formItemId: string
  formDescriptionId: string
  formMessageId: string
}
/**
 * One field's layout row. Mints the `useId()` the label/control/description/
 * message ids are all derived from, so a field can appear any number of times
 * on a page without colliding.
 */
declare function FormItem({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element
/** Label bound to the field's control by id, tinted destructive while invalid. */
declare function FormLabel({
  className,
  ...props
}: React.ComponentProps<typeof Label$1.Root>): React.JSX.Element
/**
 * Slots the accessibility wiring onto whatever single child it is given — an
 * `Input`, a `Select` trigger, a plugin's own control. It renders no element of
 * its own, so the child must forward `id` / `aria-*` to its DOM node.
 */
declare function FormControl(props: React.ComponentProps<typeof Slot.Root>): React.JSX.Element
/** Persistent helper text; always in the control's `aria-describedby`. */
declare function FormDescription({
  className,
  ...props
}: React.ComponentProps<"p">): React.JSX.Element
/**
 * Renders the field's validation message, or `children` as a hint when the
 * field is valid. Returns `null` when there is neither, so a field with no
 * error contributes no empty paragraph to the grid's row rhythm.
 *
 * The message text comes from the plugin's own resolver — this package never
 * supplies wording.
 */
declare function FormMessage({
  className,
  children,
  ...props
}: React.ComponentProps<"p">): React.JSX.Element | null

/**
 * Shared UI motion tokens — the single source of truth for the animation
 * curves used by the host *and* by plugins.
 *
 * These lived in the app (`lib/ui/motion.ts`) and 85 host modules import them
 * from there. They moved here rather than being copied because the dependency
 * has to point outward: this package must resolve with zero `@/` paths, so a
 * plugin can only share the host's motion vocabulary if the vocabulary itself
 * is the leaf. `lib/ui/motion.ts` is now a re-export shim over this file, which
 * is why the host call sites did not have to change.
 *
 * The values match the system spring used by iOS UIKit (cubic ease-out at
 * ~280 ms). They feel reasonable on Android and on desktop pointer input —
 * long enough to register but short enough that the surface stays responsive
 * under repeated interaction. The `MOBILE_*` export prefixes are retained
 * for backwards compatibility but the tokens are cross-surface.
 */

/** Durations in seconds (motion/react convention). */
declare const MOBILE_DURATION: {
  readonly fast: 0.18
  readonly normal: 0.28
  readonly slow: 0.42
}
type MobileDurationKey = keyof typeof MOBILE_DURATION

/**
 * The animation vocabulary plugins get.
 *
 * `motion` itself is deliberately NOT in the host's shared-module whitelist:
 * handing plugins the raw library would leave every plugin author to reinvent
 * the app's curves, and a plugin bundling its own copy would animate on a
 * second, unsynchronised frame loop. So this is a facade — the same
 * relationship this package already has with `radix-ui` — over the tokens in
 * `./motion-tokens`, which is the very module the host's own surfaces animate
 * from. A plugin panel and the host panel beside it therefore move alike.
 *
 * Reduced motion collapses each wrapper to a plain `<div>` rather than to a
 * zero-duration animation: same DOM shape, same `data-slot`, but no frame loop
 * and no `AnimatePresence` exit to wait on. This mirrors what the host's own
 * `MotionReveal` / `MotionCollapse` primitives do.
 */
/** Public alias — the plugin API shouldn't inherit the token module's legacy `Mobile` prefix. */
type MotionDurationKey = MobileDurationKey
/**
 * The curve / duration / rhythm values, readable by a plugin that needs to
 * animate something these four components don't cover (a canvas, a CSS
 * transition on its own markup). Seconds, matching motion/react's unit —
 * multiply by 1000 for a CSS `ms` value.
 */
declare const motionTokens: {
  /** cubic-bezier control points; iOS-style ease-out. */
  readonly ease: [number, number, number, number]
  /** Base durations in seconds, before the user's speed multiplier. */
  readonly duration: {
    readonly fast: 0.18
    readonly normal: 0.28
    readonly slow: 0.42
  }
  /** Gap between consecutive children inside a `<Stagger>`. */
  readonly stagger: {
    readonly interval: 0.04
  }
}
interface MotionPrefs {
  /**
   * The user's speed setting as a duration multiplier — the same number the
   * host writes to `--motion-duration-scale` and multiplies into the `calc()`
   * of its CSS animations. Above 1 is slower, below 1 is faster.
   */
  durationScale: number
  /** True when animation must be suppressed entirely. */
  reduced: boolean
}
/**
 * The user's current motion preferences. Use it to gate a plugin's own
 * animations — the four components below already respect it.
 */
declare function useMotionPrefs(): MotionPrefs
/**
 * DOM props forwarded verbatim to the rendered element. The handlers
 * `motion.div` redefines for its own gesture/animation system are dropped:
 * keeping them would make the same props object illegal on the plain `<div>`
 * the reduced-motion branch renders.
 */
type PassthroughProps = Omit<
  React.ComponentProps<"div">,
  "children" | "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart"
>
interface AnimatedProps extends PassthroughProps {
  children?: React.ReactNode
  /** Which token duration to run at. Defaults to `normal` (280 ms). */
  duration?: MotionDurationKey
}
interface FadeProps extends AnimatedProps {
  /** Whether the content is present. Toggling it plays the fade in / out. */
  show?: boolean
}
/**
 * Fade content in and out. `show` defaults to true so a plugin that only wants
 * a mount animation can wrap without wiring state — and so content is never
 * accidentally invisible.
 */
declare function Fade({ show, duration, children, ...props }: FadeProps): React.JSX.Element | null
interface SlideUpProps extends AnimatedProps {
  /** Whether the content is present. Toggling it plays the slide in / out. */
  show?: boolean
}
/**
 * Fade + rise. The 8px offset comes from `STAGGER_CHILD`, so a standalone
 * `SlideUp` and a row inside a `Stagger` travel the same distance — mixing the
 * two in one panel doesn't read as two different animations.
 */
declare function SlideUp({
  show,
  duration,
  children,
  ...props
}: SlideUpProps): React.JSX.Element | null
type StaggerProps = AnimatedProps
/**
 * Reveal children one after another. Each child gets a wrapper, and the wrapper
 * survives into the reduced-motion branch — dropping it would change the DOM
 * shape, and therefore the flex/grid layout, based on an accessibility setting.
 *
 * The stagger interval is *not* scaled by `durationScale`: it is a rhythm
 * between elements rather than the length of any one animation, and the host's
 * own staggered lists use `STAGGER_CONTAINER` unscaled.
 */
declare function Stagger({ duration, children, ...props }: StaggerProps): React.JSX.Element
interface CollapseProps extends AnimatedProps {
  /** Whether the body is expanded. Toggling it animates the height. */
  show?: boolean
}
/**
 * Expand / collapse a region by animating its height.
 *
 * `overflow: hidden` is an inline style rather than a utility class so the
 * clipping cannot be dropped by a Tailwind purge in a plugin's own build. The
 * token ease being monotonic matters here: a spring overshoots `auto` and,
 * under the clip, shears the last rows of content off for a frame.
 */
declare function Collapse({
  show,
  duration,
  children,
  style,
  ...props
}: CollapseProps): React.JSX.Element | null

/**
 * Anchored popover — free-form layered content, as opposed to `DropdownMenu`'s
 * roving-focus menu semantics.
 *
 * Same rationale as `dropdown-menu.tsx`: plugins get no `react-dom`, so no
 * `createPortal`, so no way to escape their slot. This file is the host-owned
 * escape hatch. Reach for `Popover` when the content is a form, a colour
 * picker, a details card — anything whose children are NOT a list of commands.
 * If they ARE commands, use `DropdownMenu`, which gives keyboard navigation,
 * typeahead and `role="menu"` for free.
 */

declare function Popover({
  ...props
}: React.ComponentProps<typeof Popover$1.Root>): React.JSX.Element
declare function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof Popover$1.Trigger>): React.JSX.Element
declare function PopoverContent({
  className,
  align,
  sideOffset,
  ...props
}: React.ComponentProps<typeof Popover$1.Content>): React.JSX.Element
/**
 * Detaches positioning from the trigger. Useful when the visual anchor is a
 * text range or a canvas cell rather than the control the user clicked — the
 * plugin can render a zero-size `PopoverAnchor` at the right coordinates and
 * keep the trigger wherever it belongs.
 */
declare function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof Popover$1.Anchor>): React.JSX.Element
/**
 * `Header` / `Title` / `Description` are plain elements, not Radix parts: a
 * popover is not a dialog, so it must NOT claim `aria-labelledby` wiring or a
 * heading role it does not own. They exist purely so plugin authors stop
 * hand-rolling the spacing and drifting from the host's look.
 */
declare function PopoverHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element
declare function PopoverTitle({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element
declare function PopoverDescription({
  className,
  ...props
}: React.ComponentProps<"p">): React.JSX.Element

/**
 * Determinate progress bar.
 *
 * Leaving `value` undefined puts Radix into its indeterminate state, but the
 * indicator below still translates by a concrete amount, so an omitted `value`
 * reads as 0% rather than "unknown". A plugin with no measurable progress
 * should show a `Skeleton` instead.
 *
 * Carries no label — pass `aria-label` or `aria-labelledby`, or the bar reaches
 * screen readers as an unnamed progressbar. Radix supplies `aria-valuetext`
 * itself as a locale-neutral percentage; override it with `getValueLabel` when
 * the plugin has a translated string to offer.
 */

declare function Progress({
  className,
  value,
  max,
  ...props
}: React.ComponentProps<typeof Progress$1.Root>): React.JSX.Element

/**
 * Single-choice control.
 *
 * Radix owns the roving tabindex here, which is the part a plugin would get
 * wrong by hand: a radio group is ONE tab stop and the arrow keys move the
 * selection inside it. Rolling this from `<input type="radio">` also means
 * every plugin instance would need a globally unique `name`, and two plugins
 * that happened to collide would silently steer each other's selection.
 */
declare function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroup$1.Root>): React.JSX.Element
/**
 * The indicator only mounts while the item is checked, so the dot cannot be
 * left behind by a stale class. Pair each item with a `Label htmlFor` — the
 * item renders no text of its own, and the kit has no locale to invent one in.
 */
declare function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroup$1.Item>): React.JSX.Element

/**
 * Scrollable region with the host's overlay scrollbar look.
 *
 * Plugins render inside host-owned slots whose height is decided by the host
 * (a dock pane, a sheet, a settings section). A plugin that lets a raw
 * `overflow-auto` div grow gets the platform's native scrollbar, which on macOS
 * and Windows looks nothing like the rest of the app. Wrapping content here
 * keeps the chrome consistent and, more importantly, keeps the overflow
 * *inside* the slot instead of pushing the host's own layout around.
 */

declare function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollArea$1.Root>): React.JSX.Element
declare function ScrollBar({
  className,
  orientation,
  ...props
}: React.ComponentProps<typeof ScrollArea$1.ScrollAreaScrollbar>): React.JSX.Element

declare function Select({ ...props }: React.ComponentProps<typeof Select$1.Root>): React.JSX.Element
declare function SelectGroup({
  ...props
}: React.ComponentProps<typeof Select$1.Group>): React.JSX.Element
declare function SelectValue({
  ...props
}: React.ComponentProps<typeof Select$1.Value>): React.JSX.Element
declare function SelectTrigger({
  className,
  size,
  children,
  ...props
}: React.ComponentProps<typeof Select$1.Trigger> & {
  size?: "sm" | "default"
}): React.JSX.Element
declare function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof Select$1.ScrollUpButton>): React.JSX.Element
declare function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof Select$1.ScrollDownButton>): React.JSX.Element
declare function SelectContent({
  className,
  children,
  position,
  align,
  ...props
}: React.ComponentProps<typeof Select$1.Content>): React.JSX.Element
declare function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof Select$1.Label>): React.JSX.Element
declare function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Select$1.Item>): React.JSX.Element
declare function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Select$1.Separator>): React.JSX.Element

/**
 * Rule between sections or inline controls.
 *
 * Defaults to `decorative` — a bare line is almost always visual grouping the
 * surrounding headings already convey, and announcing every one of them as a
 * separator turns a dense plugin panel into screen-reader noise. Pass
 * `decorative={false}` on the rare divider that carries real structure (e.g. it
 * is the only thing distinguishing two lists), which makes Radix emit
 * `role="separator"` plus `aria-orientation`.
 */

declare function Separator({
  className,
  orientation,
  decorative,
  ...props
}: React.ComponentProps<typeof Separator$1.Root>): React.JSX.Element

/**
 * Edge-anchored overlay panel.
 *
 * This exists in the kit because a plugin cannot build one itself: `react-dom`
 * is withheld from the host's shared-module whitelist
 * (`lib/plugin/core/shared-modules.ts`), so there is no `createPortal` and a
 * plugin's tree cannot escape the slot it was mounted into — nor its `@scope`d
 * stylesheet. Radix's own portal is the sanctioned escape hatch: the host owns
 * the portal container and the layering, the plugin only declares content.
 *
 * Built on Radix's Dialog primitive (a sheet is a dialog with an edge anchor),
 * which brings the focus trap, scroll lock, Escape/outside-click dismissal and
 * `aria-modal` semantics for free.
 */
declare function Sheet({ ...props }: React.ComponentProps<typeof Dialog$1.Root>): React.JSX.Element
declare function SheetTrigger({
  ...props
}: React.ComponentProps<typeof Dialog$1.Trigger>): React.JSX.Element
declare function SheetClose({
  ...props
}: React.ComponentProps<typeof Dialog$1.Close>): React.JSX.Element
declare function SheetContent({
  className,
  children,
  side,
  showCloseButton,
  closeLabel,
  forceMount,
  ...props
}: React.ComponentProps<typeof Dialog$1.Content> & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
  closeLabel?: string
}): React.JSX.Element
declare function SheetHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element
declare function SheetFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.JSX.Element
/**
 * Radix derives the dialog's accessible name from Title and its description
 * from Description — omitting Title leaves the overlay unnamed to a screen
 * reader, so both are exported rather than folded into SheetHeader.
 */
declare function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof Dialog$1.Title>): React.JSX.Element
declare function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof Dialog$1.Description>): React.JSX.Element

/**
 * Loading placeholder.
 *
 * Plugin panels are mounted eagerly by the host but almost always await their
 * own async data, so the alternative to a skeleton is an empty slot that reads
 * as "this plugin is broken". Sizing is deliberately not baked in: the caller
 * passes the box it is reserving (`className="h-4 w-32"`), because only the
 * plugin knows the shape of what is about to replace it.
 */

declare function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element

/**
 * Toast viewport. Mount **at most one** per document — Sonner is a singleton
 * and a second viewport competes for the same queue.
 *
 * Plugins should normally not render this at all: the host app already mounts a
 * `Toaster`, and `toast()` from this package addresses whichever one is live.
 * It is exported for plugins that own a detached surface (a popped-out window,
 * a webview) with no host viewport in it.
 *
 * Colours come from the host's `--popover` / `--border` / `--radius` tokens
 * rather than fixed values, so a toast raised by a plugin matches the app's
 * theme — including a theme the plugin has never heard of. The default
 * `theme="system"` follows the OS; pass the host's resolved theme when the app
 * lets the user override it.
 */
declare function Toaster({ theme, ...props }: ToasterProps): React.JSX.Element

/**
 * Range control, single- or multi-thumb.
 *
 * Radix carries the pointer-capture and page-scroll suppression that a plugin
 * cannot reproduce from its slot: dragging a thumb must keep tracking after the
 * pointer leaves the plugin's own subtree, and on touch it must not scroll the
 * host panel underneath. `touch-none` below is the other half of that.
 *
 * There is no built-in label — a slider whose only affordance is a position has
 * no accessible name, so `aria-label` / `aria-labelledby` is the caller's job.
 * Whichever is supplied is forwarded to BOTH the root and every thumb: the root
 * carries the group's name for `RadioGroup`-style announcements, while the
 * thumbs are the elements that actually hold `role="slider"` and get read out.
 */
declare function Slider({
  className,
  defaultValue,
  value,
  min,
  max,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: React.ComponentProps<typeof Slider$1.Root>): React.JSX.Element

/**
 * Boolean toggle that commits immediately (`role="switch"`), as opposed to
 * `Checkbox`, which stages a value until some surrounding form is submitted.
 * Plugin settings rows are almost always the former, so this is the one to
 * reach for there.
 *
 * The control renders no text of its own — pair it with `Label htmlFor` or pass
 * `aria-label`, otherwise it ships to screen readers as an unnamed switch.
 */

declare function Switch({
  className,
  size,
  ...props
}: React.ComponentProps<typeof Switch$1.Root> & {
  size?: "sm" | "default"
}): React.JSX.Element

/**
 * Data table.
 *
 * The only component in the kit with no Radix primitive underneath — native
 * table semantics are already the accessible ones, and wrapping them would cost
 * the row/column relationships screen readers derive from the element tree.
 *
 * `Table` renders its own scroll container rather than leaving that to the
 * caller: a plugin panel is mounted into a host-sized slot it does not control,
 * so an unclipped wide table would push the whole panel's layout instead of
 * scrolling inside it.
 */
declare function Table({ className, ...props }: React.ComponentProps<"table">): React.JSX.Element
declare function TableHeader({
  className,
  ...props
}: React.ComponentProps<"thead">): React.JSX.Element
declare function TableBody({
  className,
  ...props
}: React.ComponentProps<"tbody">): React.JSX.Element
declare function TableFooter({
  className,
  ...props
}: React.ComponentProps<"tfoot">): React.JSX.Element
/**
 * `data-state="selected"` is the selection hook rather than a `selected` prop:
 * selection lives in the plugin's own state and the row only has to reflect it,
 * so nothing here needs to become stateful. `has-aria-expanded` lights the same
 * tint for a row that owns an expanded detail region.
 */
declare function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.JSX.Element
declare function TableHead({ className, ...props }: React.ComponentProps<"th">): React.JSX.Element
declare function TableCell({ className, ...props }: React.ComponentProps<"td">): React.JSX.Element
declare function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">): React.JSX.Element

declare function Tabs({
  className,
  orientation,
  ...props
}: React.ComponentProps<typeof Tabs$1.Root>): React.JSX.Element
declare const tabsListVariants: (
  props?:
    | ({
        variant?: "line" | "default" | null | undefined
      } & class_variance_authority_types.ClassProp)
    | undefined
) => string
declare function TabsList({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof Tabs$1.List> &
  VariantProps<typeof tabsListVariants>): React.JSX.Element
declare function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof Tabs$1.Trigger>): React.JSX.Element
declare function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof Tabs$1.Content>): React.JSX.Element

/**
 * Multi-line text field, styled to match `Input`.
 *
 * Auto-grows via `field-sizing-content` instead of a resize-observer loop, so a
 * plugin that renders one in a dock pane does not fight the host for layout
 * passes. Callers that need a hard ceiling add `max-h-*`; the browser keeps the
 * box at content height below that.
 */

declare function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.JSX.Element

declare function TooltipProvider({
  delayDuration,
  ...props
}: React.ComponentProps<typeof Tooltip$1.Provider>): React.JSX.Element
declare function Tooltip({
  ...props
}: React.ComponentProps<typeof Tooltip$1.Root>): React.JSX.Element
declare function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof Tooltip$1.Trigger>): React.JSX.Element
declare function TooltipContent({
  className,
  sideOffset,
  children,
  ...props
}: React.ComponentProps<typeof Tooltip$1.Content>): React.JSX.Element

export {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertTitle,
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapse,
  type CollapseProps,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Fade,
  type FadeProps,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Input,
  Label,
  type MotionDurationKey,
  type MotionPrefs,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
  Progress,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  ScrollBar,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  SlideUp,
  type SlideUpProps,
  Slider,
  Stagger,
  type StaggerProps,
  Switch,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Toaster,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  alertVariants,
  badgeVariants,
  buttonVariants,
  cn,
  motionTokens,
  tabsListVariants,
  useFormField,
  useMotionPrefs,
}
