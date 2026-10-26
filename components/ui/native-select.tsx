"use client"

import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { isNativeMobile, isTauri } from "@/lib/platform/detect"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { useMediaQuery } from "@/hooks/ui/use-media-query"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default"
  wrapperClassName?: string
  /** OS picker required to paint above an embedded native child WebView. */
  native?: boolean
}

type Option = { value: string; label: React.ReactNode; disabled?: boolean; group?: string }

function readOptions(children: React.ReactNode, disabled = false, group?: string): Option[] {
  return React.Children.toArray(children).flatMap((child): Option[] => {
    if (!React.isValidElement<React.ComponentProps<"option">>(child)) return []
    if (child.type === React.Fragment) return readOptions(child.props.children, disabled, group)
    if (child.type === NativeSelectOptGroup || child.type === "optgroup") {
      return readOptions(child.props.children, disabled || child.props.disabled, child.props.label)
    }
    return [
      {
        value: String(child.props.value ?? child.props.children ?? ""),
        label: child.props.label ?? child.props.children,
        disabled: disabled || child.props.disabled,
        group,
      },
    ]
  })
}

/**
 * Keep the HTML-select API at existing call sites, including a real select
 * change event and unencoded form values. Only the desktop picker is Radix.
 * Empty option values are encoded for Radix, where an empty item is invalid.
 */
function DesktopSelect({ className, size, children, ref, ...props }: NativeSelectProps) {
  const options = readOptions(children)
  const firstValue = options.find((option) => !option.disabled)?.value ?? ""
  const groups: { label?: string; items: Option[] }[] = []
  for (const option of options) {
    const previous = groups.at(-1)
    if (!previous || previous.label !== option.group)
      groups.push({ label: option.group, items: [option] })
    else previous.items.push(option)
  }
  const [uncontrolledValue, setUncontrolledValue] = React.useState(() =>
    String(props.defaultValue ?? firstValue)
  )
  const requestedValue = String(props.value ?? uncontrolledValue)
  const value = options.some((option) => option.value === requestedValue)
    ? requestedValue
    : firstValue
  const nativeRef = React.useRef<HTMLSelectElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    const form = nativeRef.current?.form
    const reset = () => setUncontrolledValue(String(props.defaultValue ?? firstValue))
    form?.addEventListener("reset", reset)
    return () => form?.removeEventListener("reset", reset)
  }, [props.defaultValue, firstValue])

  const accessibilityProps = Object.fromEntries(
    Object.entries(props).filter(([key]) => key.startsWith("aria-") || key.startsWith("data-"))
  )
  const nativeProps = Object.fromEntries(
    Object.entries(props).filter(([key]) => !key.startsWith("aria-") && !key.startsWith("data-"))
  ) as React.ComponentProps<"select">

  return (
    <div
      className="contents"
      onChangeCapture={(event) => {
        // Radix also emits from its own form mirror. Our native mirror below
        // owns the legacy change event, so forms receive it exactly once.
        if (event.target !== (nativeRef.current as EventTarget | null)) event.stopPropagation()
      }}
    >
      <Select
        value={`option:${value}`}
        disabled={props.disabled}
        onValueChange={(next) => {
          const native = nativeRef.current
          if (!native) return
          native.value = next.slice("option:".length)
          native.dispatchEvent(new Event("change", { bubbles: true }))
        }}
      >
        <SelectTrigger
          {...accessibilityProps}
          aria-required={props.required || props["aria-required"]}
          ref={triggerRef}
          value={value}
          id={props.id}
          size={size}
          className={cn("w-full min-w-0", className)}
          style={props.style}
          title={props.title}
          tabIndex={props.tabIndex}
          autoFocus={props.autoFocus}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {groups.map(({ label, items }, index) => (
            <SelectGroup key={index}>
              {label && <SelectLabel>{label}</SelectLabel>}
              {items.map((option) => (
                <SelectItem
                  key={option.value}
                  value={`option:${option.value}`}
                  disabled={option.disabled}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <select
        {...nativeProps}
        id={undefined}
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        style={undefined}
        data-slot="native-select"
        ref={(node) => {
          nativeRef.current = node
          if (typeof ref === "function") return ref(node)
          if (ref) ref.current = node
        }}
        onChange={(event) => {
          setUncontrolledValue(event.currentTarget.value)
          props.onChange?.(event)
        }}
        onInvalid={(event) => {
          props.onInvalid?.(event)
          if (!event.defaultPrevented) triggerRef.current?.focus()
        }}
      >
        {children}
      </select>
    </div>
  )
}

/**
 * A `select` is not a Radix trigger: the UA centres the selected option inside
 * the *content* box and clips whatever does not fit, so vertical padding here
 * buys nothing visually and only shrinks the room the text has. That is why
 * this control carries no `py-*`. Call sites routinely tighten it to `h-8` or
 * `h-7`, and with `py-2` in the base those heights cut the descenders off
 * every label. Height alone now decides the box, and the text stays centred in
 * it at any size.
 */
function NativeSelect({
  className,
  wrapperClassName,
  size = "default",
  native = false,
  ...props
}: NativeSelectProps) {
  const mobileLayout = useIsMobile()
  const touchOnly = useMediaQuery("(pointer: coarse) and (hover: none)")
  // A narrow desktop window still uses Radix. Capacitor stays native even
  // with a keyboard attached; touch-only web devices keep their OS picker.
  const nativePicker = native || (!isTauri() && (touchOnly || (mobileLayout && isNativeMobile())))
  return (
    <div
      className={cn(
        "group/native-select relative w-fit",
        (nativePicker || props.multiple) && "has-[select:disabled]:opacity-50",
        wrapperClassName
      )}
      data-slot="native-select-wrapper"
    >
      {nativePicker || props.multiple ? (
        <select
          data-slot="native-select"
          data-size={size}
          className={cn(
            "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-0 pr-9 text-sm shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-8 dark:bg-input/30 dark:hover:bg-input/50",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
            className
          )}
          {...props}
        />
      ) : (
        <DesktopSelect {...props} size={size} className={className} />
      )}
      {(nativePicker || props.multiple) && (
        <ChevronDownIcon
          className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground opacity-50 select-none"
          aria-hidden="true"
          data-slot="native-select-icon"
        />
      )}
    </div>
  )
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
