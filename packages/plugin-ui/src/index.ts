/**
 * `@cognia/plugin-ui` — the component surface third-party plugins render with.
 *
 * A plugin imports from here and marks the package external at build time
 * (`cognia plugin build` does this for you). At load time the host resolves
 * `require("@cognia/plugin-ui")` to its own already-evaluated copy, so every
 * plugin shares one instance and one React — see
 * `lib/plugin/core/loader.ts` for the shared-module whitelist.
 *
 * These components carry no colors of their own: they render against the CSS
 * custom properties the host publishes on `:root` (see the token contract in
 * `docs/content/docs/plugin-dev/surfaces.mdx`), so they follow the user's
 * theme, density and motion settings without the plugin doing anything.
 *
 * The same arrangement extends to animation, and there it is load-bearing
 * rather than cosmetic. Eight files here — `accordion`, `context-menu`,
 * `dropdown-menu`, `hover-card`, `popover`, `select`, `sheet`, `tooltip` — use
 * `tw-animate-css` utilities that the *app* supplies (`app/globals.css` imports
 * the stylesheet; this package does not and cannot). Nothing enforces that
 * coupling, so it is written down here: rendered outside the host stylesheet
 * all eight degrade together, and `accordion` degrades worst. Radix's `Presence`
 * only defers an unmount while `animationName` computes to something other than
 * `"none"`, so a missing keyframe there is not a missing animation — it is an
 * instant unmount of exiting content.
 */

export { cn } from "./cn"
export { CopyFeedbackIcon, type CopyFeedbackIconProps } from "./copy-feedback-icon"
export { PluginImage, type PluginImageProps } from "./plugin-image"
export { parseToolOutput, ToolCard, type ToolCardProps, useParsedToolOutput } from "./tool-card"
export { useCopy, type UseCopyOptions, type UseCopyResult } from "./use-copy"

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./accordion"
export { Alert, AlertDescription, AlertTitle, alertVariants } from "./alert"
export {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./avatar"
export { Badge, badgeVariants } from "./badge"
export { Button, buttonVariants } from "./button"
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card"
export { Checkbox } from "./checkbox"
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible"
export {
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
} from "./dialog"
export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command"
export {
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
} from "./context-menu"
export {
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
} from "./dropdown-menu"
export { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card"
export { Input } from "./input"
export { Label } from "./label"
export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
} from "./form"
// Motion. Deliberately only the facade — the raw `MOBILE_*` tokens in
// `./motion-tokens` keep the host's historical names and are not a contract we
// want to owe plugins; `motionTokens` covers every read-only need. The host
// reaches the raw module through a deep import, which plugins cannot do (the
// shared-module whitelist lists no subpaths).
export {
  Collapse,
  Fade,
  SlideUp,
  Stagger,
  motionTokens,
  useMotionPrefs,
  type CollapseProps,
  type FadeProps,
  type MotionDurationKey,
  type MotionPrefs,
  type SlideUpProps,
  type StaggerProps,
} from "./motion"
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover"
export { Progress } from "./progress"
export { RadioGroup, RadioGroupItem } from "./radio-group"
export { ScrollArea, ScrollBar } from "./scroll-area"
export {
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
} from "./select"
export { Separator } from "./separator"
// `SheetOverlay` / `SheetPortal` are intentionally not exported — `SheetContent`
// renders both internally, matching the host. Same for `CommandDialog`, which is
// omitted entirely: centered modals belong to the runtime `ctx.modal.openModal()`
// API, and a second implementation would fight it over focus and escape.
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet"
export { Skeleton } from "./skeleton"
export { Toaster, toast } from "./sonner"
export { Slider } from "./slider"
export { Switch } from "./switch"
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table"
export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants } from "./tabs"
export { Textarea } from "./textarea"
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip"
