"use client"

import { useControllableState } from "@radix-ui/react-use-controllable-state"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { ChevronsUpDownIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"

const deviceIdRegex = /\(([\da-fA-F]{4}:[\da-fA-F]{4})\)$/

export type MicPermissionState = "granted" | "denied" | "prompt" | "unknown"

export interface MicSelectorPermission {
  state: MicPermissionState
  loading: boolean
  request: () => Promise<void>
}

interface MicSelectorContextType {
  data: MediaDeviceInfo[]
  permission: MicSelectorPermission
  value: string | undefined
  onValueChange?: (value: string) => void
  open: boolean
  onOpenChange?: (open: boolean) => void
  width: number
  setWidth?: (width: number) => void
}

const noopRequest = async () => {}

const MicSelectorContext = createContext<MicSelectorContextType>({
  data: [],
  onOpenChange: undefined,
  onValueChange: undefined,
  open: false,
  permission: { loading: false, request: noopRequest, state: "unknown" },
  setWidth: undefined,
  value: undefined,
  width: 200,
})

const hasMediaDevices = () =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices !== "undefined"

export const useAudioDevices = () => {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [permissionState, setPermissionState] = useState<MicPermissionState>("unknown")

  // Enumerate-only refresh — never triggers a permission prompt. Device
  // labels are only exposed once permission is granted, so a labelled
  // audioinput doubles as a "granted" signal on browsers without the
  // Permissions API.
  const refreshDevices = useCallback(async () => {
    if (!hasMediaDevices()) {
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      setError(null)

      const deviceList = await navigator.mediaDevices.enumerateDevices()
      const audioInputs = deviceList.filter((device) => device.kind === "audioinput")

      setDevices(audioInputs)
      if (audioInputs.some((device) => device.label)) {
        setPermissionState("granted")
      }
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : "Failed to get audio devices"

      setError(message)
      console.error("Error getting audio devices:", message)
    } finally {
      setLoading(false)
    }
  }, [])

  // The ONLY code path that may show a permission prompt — call it from an
  // explicit user gesture (e.g. a "grant access" button), never from an
  // open/mount effect.
  const requestPermission = useCallback(async () => {
    if (!hasMediaDevices()) {
      return
    }
    try {
      setLoading(true)
      setError(null)

      const tempStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      })

      for (const track of tempStream.getTracks()) {
        track.stop()
      }

      setPermissionState("granted")

      const deviceList = await navigator.mediaDevices.enumerateDevices()
      const audioInputs = deviceList.filter((device) => device.kind === "audioinput")

      setDevices(audioInputs)
    } catch (caughtError) {
      const name = caughtError instanceof Error ? caughtError.name : ""
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPermissionState("denied")
      }
      const message =
        caughtError instanceof Error ? caughtError.message : "Failed to get audio devices"

      setError(message)
      console.error("Error getting audio devices:", message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!hasMediaDevices()) {
      setLoading(false)
      return
    }

    let cancelled = false
    let status: PermissionStatus | null = null
    const handlePermissionChange = () => {
      if (cancelled || !status) return
      setPermissionState(status.state as MicPermissionState)
      if (status.state === "granted") {
        void refreshDevices()
      }
    }

    const syncPermission = async () => {
      try {
        status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        })
        if (cancelled) return
        setPermissionState(status.state as MicPermissionState)
        status.addEventListener("change", handlePermissionChange)
      } catch {
        // Permissions API unavailable (Firefox/WebKit variants) — the
        // labelled-device inference in refreshDevices covers "granted".
      }
    }

    void syncPermission()
    void refreshDevices()

    return () => {
      cancelled = true
      status?.removeEventListener("change", handlePermissionChange)
    }
  }, [refreshDevices])

  useEffect(() => {
    if (!hasMediaDevices() || typeof navigator.mediaDevices.addEventListener !== "function") {
      return
    }
    const handleDeviceChange = () => {
      void refreshDevices()
    }

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange)

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange)
    }
  }, [refreshDevices])

  return {
    devices,
    error,
    hasPermission: permissionState === "granted",
    loadDevices: requestPermission,
    loading,
    permissionState,
    requestPermission,
  }
}

export type MicSelectorProps = ComponentProps<typeof Popover> & {
  defaultValue?: string
  value?: string | undefined
  onValueChange?: (value: string | undefined) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export const MicSelector = ({
  defaultValue,
  value: controlledValue,
  onValueChange: controlledOnValueChange,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  ...props
}: MicSelectorProps) => {
  const [value, onValueChange] = useControllableState<string | undefined>({
    defaultProp: defaultValue,
    onChange: controlledOnValueChange,
    prop: controlledValue,
  })
  const [open, onOpenChange] = useControllableState({
    defaultProp: defaultOpen,
    onChange: controlledOnOpenChange,
    prop: controlledOpen,
  })
  const [width, setWidth] = useState(200)
  const { devices, loading, permissionState, requestPermission } = useAudioDevices()

  const permission = useMemo<MicSelectorPermission>(
    () => ({ loading, request: requestPermission, state: permissionState }),
    [loading, permissionState, requestPermission]
  )

  const contextValue = useMemo(
    () => ({
      data: devices,
      onOpenChange,
      onValueChange,
      open,
      permission,
      setWidth,
      value,
      width,
    }),
    [devices, onOpenChange, onValueChange, open, permission, setWidth, value, width]
  )

  return (
    <MicSelectorContext.Provider value={contextValue}>
      <Popover {...props} onOpenChange={onOpenChange} open={open} />
    </MicSelectorContext.Provider>
  )
}

export type MicSelectorTriggerProps = ComponentProps<typeof Button>

export const MicSelectorTrigger = ({ children, ...props }: MicSelectorTriggerProps) => {
  const { setWidth } = useContext(MicSelectorContext)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Create a ResizeObserver to detect width changes
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newWidth = (entry.target as HTMLElement).offsetWidth
        if (newWidth) {
          setWidth?.(newWidth)
        }
      }
    })

    if (ref.current) {
      resizeObserver.observe(ref.current)
    }

    // Clean up the observer when component unmounts
    return () => {
      resizeObserver.disconnect()
    }
  }, [setWidth])

  return (
    <PopoverTrigger asChild>
      <Button variant="outline" {...props} ref={ref}>
        {children}
        <ChevronsUpDownIcon className="shrink-0 text-muted-foreground" size={16} />
      </Button>
    </PopoverTrigger>
  )
}

export type MicSelectorContentProps = ComponentProps<typeof Command> & {
  popoverOptions?: ComponentProps<typeof PopoverContent>
}

export const MicSelectorContent = ({
  className,
  popoverOptions,
  ...props
}: MicSelectorContentProps) => {
  const { width, onValueChange, value } = useContext(MicSelectorContext)

  return (
    <PopoverContent className={cn("p-0", className)} style={{ width }} {...popoverOptions}>
      <Command onValueChange={onValueChange} value={value} {...props} />
    </PopoverContent>
  )
}

export type MicSelectorInputProps = ComponentProps<typeof CommandInput> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
}

export const MicSelectorInput = ({ ...props }: MicSelectorInputProps) => (
  <CommandInput placeholder="Search microphones..." {...props} />
)

export type MicSelectorListProps = Omit<ComponentProps<typeof CommandList>, "children"> & {
  children: (devices: MediaDeviceInfo[], permission: MicSelectorPermission) => ReactNode
}

export const MicSelectorList = ({ children, ...props }: MicSelectorListProps) => {
  const { data, permission } = useContext(MicSelectorContext)

  return <CommandList {...props}>{children(data, permission)}</CommandList>
}

export type MicSelectorRequestAccessProps = ComponentProps<typeof Button>

/**
 * Explicit "grant microphone access" affordance — the only UI that triggers
 * a permission prompt. Render it (with a localized label as children) when
 * `permission.state` is "prompt"/"unknown" and devices are unlabelled.
 */
export const MicSelectorRequestAccess = ({
  className,
  children,
  onClick,
  ...props
}: MicSelectorRequestAccessProps) => {
  const { permission } = useContext(MicSelectorContext)

  return (
    <Button
      className={cn("w-full justify-start gap-2 rounded-none text-xs", className)}
      disabled={permission.loading}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          void permission.request()
        }
      }}
      size="sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children}
    </Button>
  )
}

export type MicSelectorEmptyProps = ComponentProps<typeof CommandEmpty>

export const MicSelectorEmpty = ({
  children = "No microphone found.",
  ...props
}: MicSelectorEmptyProps) => <CommandEmpty {...props}>{children}</CommandEmpty>

export type MicSelectorItemProps = ComponentProps<typeof CommandItem>

export const MicSelectorItem = (props: MicSelectorItemProps) => {
  const { onValueChange, onOpenChange } = useContext(MicSelectorContext)

  const handleSelect = useCallback(
    (currentValue: string) => {
      onValueChange?.(currentValue)
      onOpenChange?.(false)
    },
    [onValueChange, onOpenChange]
  )

  return <CommandItem onSelect={handleSelect} {...props} />
}

export type MicSelectorLabelProps = ComponentProps<"span"> & {
  device: MediaDeviceInfo
}

export const MicSelectorLabel = ({ device, className, ...props }: MicSelectorLabelProps) => {
  const matches = device.label.match(deviceIdRegex)

  if (!matches) {
    return (
      <span className={className} {...props}>
        {device.label}
      </span>
    )
  }

  const [, deviceId] = matches
  const name = device.label.replace(deviceIdRegex, "")

  return (
    <span className={className} {...props}>
      <span>{name}</span>
      <span className="text-muted-foreground"> ({deviceId})</span>
    </span>
  )
}

export type MicSelectorValueProps = ComponentProps<"span">

export const MicSelectorValue = ({ className, ...props }: MicSelectorValueProps) => {
  const { data, value } = useContext(MicSelectorContext)
  const currentDevice = data.find((d) => d.deviceId === value)

  if (!currentDevice) {
    return (
      <span className={cn("flex-1 text-left", className)} {...props}>
        Select microphone...
      </span>
    )
  }

  return (
    <MicSelectorLabel
      className={cn("flex-1 text-left", className)}
      device={currentDevice}
      {...props}
    />
  )
}
