import type { Meta, StoryObj } from "@storybook/nextjs"
import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  BracesIcon,
  CameraIcon,
  CookieIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MousePointerSquareDashedIcon,
  SearchIcon,
} from "lucide-react"

import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { BrowserAgentIndicator } from "./browser-agent-indicator"
import { BrowserEngineChip } from "./browser-engine-chip"
import { BrowserLoadError } from "./browser-load-error"
import { BrowserNavigationControls } from "./browser-navigation-controls"
import { BrowserToolbar, addressDisplayParts } from "./browser-toolbar"
import { BrowserZoomControl } from "./browser-zoom-control"

// The pane's existing story uses the web fallback's much smaller action roster.
// Exercise the shared toolbar with the full desktop roster at its breakpoints.
function ToolbarPreview({
  width,
  height,
  failure = false,
  timedOut = false,
}: {
  width: number
  height?: number
  failure?: boolean
  timedOut?: boolean
}) {
  const t = useTranslations("browser")
  const tCdp = useTranslations("browserCdp")
  const tCookies = useTranslations("browser.cookieImport")
  const tDownloads = useTranslations("browserLocal.downloads")
  const toolbarRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const [showFailure, setShowFailure] = useState(failure)
  const [url, setUrl] = useState("http://localhost:3000/smoke/browser-toolbar")
  const [zoom, setZoom] = useState(1.1)
  const [engine, setEngine] = useState<"embedded" | "local-chromium">("embedded")
  const [selectMode, setSelectMode] = useState(false)
  const [lastAction, setLastAction] = useState<string | null>(null)
  const inspect = [
    [CameraIcon, t("actions.screenshot")],
    [MousePointerSquareDashedIcon, t("actions.selectElement")],
    [SearchIcon, t("actions.find")],
    [BracesIcon, tCdp("title")],
  ] as const
  const page = [
    [CookieIcon, tCookies("action")],
    [DownloadIcon, tDownloads("title")],
    [ExternalLinkIcon, t("actions.openExternal")],
  ] as const

  return (
    <div
      className="flex max-w-full min-h-0 flex-col border bg-background"
      style={{ width, height }}
    >
      <BrowserToolbar
        toolbarRef={toolbarRef}
        urlInputRef={urlInputRef}
        url={url}
        onUrlChange={setUrl}
        onSubmit={(event) => {
          event.preventDefault()
          setShowFailure(false)
        }}
        addressDisplay={addressDisplayParts(url)}
        collapsedActive={selectMode || zoom !== 1}
        navigation={
          <BrowserNavigationControls
            onBack={() => setLastAction(t("actions.back"))}
            onForward={() => setLastAction(t("actions.forward"))}
            onReload={() => setLastAction(t("actions.reload"))}
          />
        }
        inspectActions={inspect.map(([Icon, label]) => (
          <TooltipIconButton
            key={label}
            tooltip={label}
            aria-label={label}
            aria-pressed={Icon === MousePointerSquareDashedIcon ? selectMode : undefined}
            onClick={() => {
              setLastAction(label)
              if (Icon === MousePointerSquareDashedIcon) setSelectMode(!selectMode)
            }}
          >
            <Icon />
          </TooltipIconButton>
        ))}
        pageActions={
          <>
            <BrowserEngineChip engine={engine} onSwitch={setEngine} />
            <BrowserZoomControl zoom={zoom} onZoomChange={setZoom} />
            {page.map(([Icon, label]) => (
              <TooltipIconButton
                key={label}
                tooltip={label}
                aria-label={label}
                onClick={() => setLastAction(label)}
              >
                <Icon />
              </TooltipIconButton>
            ))}
          </>
        }
        overflowExtras={<span className="text-xs">{t("detail.label")}</span>}
        trailing={<BrowserAgentIndicator driver="human" lastAction={lastAction} />}
      />
      <div className={height ? "min-h-0 flex-1 bg-muted/10" : "h-96 bg-muted/10"}>
        {showFailure && (
          <BrowserLoadError
            url={url}
            timedOut={timedOut}
            onRetry={() => setShowFailure(false)}
            onEditAddress={() => urlInputRef.current?.focus()}
            onOpenExternal={() => setLastAction(t("actions.openExternal"))}
            onContinue={timedOut ? () => setShowFailure(false) : undefined}
          />
        )}
      </div>
    </div>
  )
}

const meta = {
  title: "Browser/BrowserToolbar",
  component: ToolbarPreview,
  parameters: { layout: "padded" },
  args: { width: 682 },
} satisfies Meta<typeof ToolbarPreview>

export default meta
type Story = StoryObj<typeof meta>

export const FullToolbar: Story = {}
export const MediumSidebar: Story = { args: { width: 500 } }
export const NarrowSidebar: Story = { args: { width: 320 } }
export const LoadFailure: Story = { args: { width: 320, failure: true } }
export const LoadTimeout: Story = { args: { width: 320, failure: true, timedOut: true } }
export const ShortSidebar: Story = {
  args: { width: 280, height: 240, failure: true, timedOut: true },
}
