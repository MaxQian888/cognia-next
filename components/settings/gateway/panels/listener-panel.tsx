"use client"

/**
 * Settings → Gateway → Listener — where the gateway binds and who may reach it.
 *
 * `GatewayState` splits its config in two: request-time fields (timeouts, retry
 * policy, model exposure, per-key limits) are read live on every request, while
 * bind-time fields — port, interface, allowlist, the global rate limit — are
 * snapshotted when the listener starts and do nothing until it is restarted.
 *
 * Each bind-time field carries a `BindTimeBadge`, and the restart itself lives
 * in the section-level banner, driven by Rust's `pendingRestartFields`. This
 * panel used to track "dirty" itself: the allowlist flag died with the panel
 * on navigation, the interface comparison read a status field Rust filled from
 * the *saved* config (so it cleared on the next status read), and the global
 * rate limit sat on the Reliability panel under an "applies immediately"
 * badge while Rust only read it at bind.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ShieldCheckIcon } from "lucide-react"

import { MotionCollapse } from "@/components/chat/motion/motion-reveal"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { isValidAllowlistEntry, isValidPublicOrigin } from "@/lib/gateway/config-schema"
import { type GatewayBindInterface } from "@/types/gateway"

import { ChipInput } from "../shared/chip-input"
import { BindTimeBadge } from "../shared/bind-time-badge"
import { DeferredTextInput } from "../../common/deferred-text-input"
import { NumberRow } from "../../common/number-row"
import type { GatewayPanelContext } from "../gateway-section"
import { GatewayPanelSection, GatewayPanelStack } from "../shared/panel-section"

export interface GatewayListenerPanelProps {
  ctx: GatewayPanelContext
}

/** True when the allowlist admits this machine and nothing else. */
export function allowlistIsLoopbackOnly(allowlist: readonly string[]): boolean {
  return allowlist.length > 0 && allowlist.every((entry) => entry.trim().startsWith("127."))
}

export function GatewayListenerPanel({ ctx }: GatewayListenerPanelProps) {
  const t = useTranslations("settings.gateway")
  const { config, persist, pendingRestartFields } = ctx
  // A malformed public origin is refused by the Rust config validator, which
  // would surface as an opaque toast. Catch it here and say which field.
  const [publicOriginError, setPublicOriginError] = useState(false)

  const commitPublicOrigin = useCallback(
    (next: string) => {
      if (!isValidPublicOrigin(next)) {
        setPublicOriginError(true)
        return
      }
      setPublicOriginError(false)
      // Empty means unset, and `null` is what the Rust `Option<String>` reads.
      void persist({ publicOrigin: next.trim() === "" ? null : next.trim() })
    },
    [persist]
  )

  const lan = config.bindInterface === "lan"
  // Rust admits a connection only when an entry matches, so an empty list
  // refuses every caller — this machine included.
  const allowlistEmpty = config.allowlist.length === 0
  const lanUnreachable = lan && allowlistIsLoopbackOnly(config.allowlist)

  return (
    <GatewayPanelStack>
      <GatewayPanelSection title={t("listenerHeading")} description={t("listenerHelp")}>
        <NumberRow
          id="gw-port"
          label={t("port")}
          help={t("portHelp")}
          adornment={<BindTimeBadge field="port" pending={pendingRestartFields} />}
          value={config.port}
          min={1024}
          max={65535}
          onCommit={(v) => void persist({ port: v })}
        />

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label id="gw-bind-interface-label">{t("bindInterface")}</Label>
            <BindTimeBadge field="bindInterface" pending={pendingRestartFields} />
          </div>
          {/* Spaced, not joined: the two labels carry their addresses and need
              ~340px side by side, so a narrow pane wraps them — which reads as
              two options when they are separate chips and as a broken control
              when they are one segmented bar. */}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={1}
            className="flex-wrap"
            value={config.bindInterface}
            onValueChange={(value) => {
              if (value) void persist({ bindInterface: value as GatewayBindInterface })
            }}
            aria-labelledby="gw-bind-interface-label"
          >
            {(["loopback", "lan"] as const).map((iface) => (
              <ToggleGroupItem
                key={iface}
                value={iface}
                aria-label={t(iface === "loopback" ? "bindLoopback" : "bindLan")}
              >
                {t(iface === "loopback" ? "bindLoopback" : "bindLan")}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">{t("bindHelp")}</p>
          <MotionCollapse open={lan}>
            <Alert>
              <AlertTriangleIcon />
              <AlertDescription>{t("lanWarning")}</AlertDescription>
            </Alert>
          </MotionCollapse>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="gw-public-origin">{t("publicOrigin")}</Label>
            <Badge variant="outline" className="text-[10px] font-normal">
              {t("liveBadge")}
            </Badge>
          </div>
          <DeferredTextInput
            id="gw-public-origin"
            value={config.publicOrigin ?? ""}
            onCommit={commitPublicOrigin}
            placeholder={t("publicOriginPlaceholder")}
            aria-label={t("publicOrigin")}
            aria-invalid={publicOriginError}
            data-testid="gateway-public-origin"
          />
          <p className="text-xs text-muted-foreground">{t("publicOriginHelp")}</p>
          <MotionCollapse open={publicOriginError}>
            <Alert variant="destructive" data-testid="gateway-public-origin-error">
              <AlertTriangleIcon />
              <AlertDescription>{t("publicOriginInvalid")}</AlertDescription>
            </Alert>
          </MotionCollapse>
        </div>
      </GatewayPanelSection>

      <GatewayPanelSection
        icon={<ShieldCheckIcon className="size-4" />}
        title={t("accessHeading")}
        description={t("accessHelp")}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label>{t("allowlist")}</Label>
            <BindTimeBadge field="allowlist" pending={pendingRestartFields} />
          </div>
          <ChipInput
            values={config.allowlist}
            onCommit={(next) => void persist({ allowlist: next })}
            validate={(value) => (isValidAllowlistEntry(value) ? null : t("allowlistInvalid"))}
            placeholder={t("allowlistPlaceholder")}
            ariaLabel={t("allowlist")}
            addLabel={t("add")}
            removeLabel={t("remove")}
          />
          <p className="text-xs text-muted-foreground">{t("allowlistHelp")}</p>
          <MotionCollapse open={allowlistEmpty}>
            <Alert variant="destructive" data-testid="gateway-allowlist-empty">
              <AlertTriangleIcon />
              <AlertDescription>{t("allowlistEmpty")}</AlertDescription>
            </Alert>
          </MotionCollapse>
          <MotionCollapse open={lanUnreachable}>
            <Alert data-testid="gateway-lan-unreachable">
              <AlertTriangleIcon />
              <AlertDescription>{t("lanAllowlistLoopbackOnly")}</AlertDescription>
            </Alert>
          </MotionCollapse>
        </div>

        <NumberRow
          id="gw-rate-limit"
          label={t("rateLimit")}
          help={t("rateLimitHelp")}
          adornment={<BindTimeBadge field="rateLimitPerMin" pending={pendingRestartFields} />}
          value={config.rateLimitPerMin}
          min={1}
          max={60000}
          onCommit={(v) => void persist({ rateLimitPerMin: v })}
        />
      </GatewayPanelSection>
    </GatewayPanelStack>
  )
}
