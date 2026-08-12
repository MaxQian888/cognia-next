"use client"

import { useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import {
  ActivityIcon,
  BellIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleXIcon,
  Clock3Icon,
  GaugeIcon,
  RadioTowerIcon,
  WrenchIcon,
} from "lucide-react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  calculateUptime,
  createPreviewStatusSnapshot,
  deriveOverallStatus,
  sortIncidentUpdatesNewestFirst,
  type Incident,
  type PublicStatusSnapshot,
  type ServiceStatus,
  type StatusComponent,
} from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

const STATUS_ORDER: ServiceStatus[] = [
  "operational",
  "maintenance",
  "degraded",
  "partial_outage",
  "major_outage",
]

const STATUS_STYLES: Record<
  ServiceStatus,
  { dot: string; soft: string; text: string; icon: typeof CheckCircle2Icon }
> = {
  operational: {
    dot: "bg-emerald-500",
    soft: "bg-emerald-500/10 ring-emerald-500/20",
    text: "text-emerald-700 dark:text-emerald-300",
    icon: CheckCircle2Icon,
  },
  maintenance: {
    dot: "bg-sky-500",
    soft: "bg-sky-500/10 ring-sky-500/20",
    text: "text-sky-700 dark:text-sky-300",
    icon: WrenchIcon,
  },
  degraded: {
    dot: "bg-amber-500",
    soft: "bg-amber-500/10 ring-amber-500/20",
    text: "text-amber-800 dark:text-amber-300",
    icon: CircleAlertIcon,
  },
  partial_outage: {
    dot: "bg-orange-500",
    soft: "bg-orange-500/10 ring-orange-500/20",
    text: "text-orange-800 dark:text-orange-300",
    icon: CircleAlertIcon,
  },
  major_outage: {
    dot: "bg-rose-600",
    soft: "bg-rose-500/10 ring-rose-500/20",
    text: "text-rose-700 dark:text-rose-300",
    icon: CircleXIcon,
  },
}

export interface PublicStatusPageProps {
  snapshot?: PublicStatusSnapshot
}

export function PublicStatusPage({
  snapshot = createPreviewStatusSnapshot(),
}: PublicStatusPageProps) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()
  const reducedMotion = useReducedMotion()
  const [subscriptionOpen, setSubscriptionOpen] = useState(false)
  const [subscriptionSubmitted, setSubscriptionSubmitted] = useState(false)
  const overallStatus = deriveOverallStatus(
    snapshot.components.map((component) => component.status)
  )
  const platformUptime = calculateUptime(snapshot.components.flatMap((item) => item.history))
  const overallStyle = STATUS_STYLES[overallStatus]
  const OverallIcon = overallStyle.icon
  const reveal = reducedMotion
    ? {}
    : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 } }

  const openSubscription = () => {
    setSubscriptionSubmitted(false)
    setSubscriptionOpen(true)
  }

  return (
    <main className="relative min-h-dvh w-full max-w-full overflow-x-hidden bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[44rem] bg-[radial-gradient(circle_at_78%_4%,color-mix(in_oklch,var(--primary)_8%,transparent),transparent_43%),radial-gradient(circle_at_8%_18%,color-mix(in_oklch,var(--chart-2)_9%,transparent),transparent_38%)]"
      />

      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/88 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <a
            href="#top"
            className="group flex items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid size-8 place-items-center rounded-lg bg-foreground text-xs font-semibold text-background transition-transform duration-200 group-hover:-rotate-3">
              {t("brandMark")}
            </span>
            <span className="flex items-baseline gap-2">
              <span className="font-semibold tracking-tight">{t("brand")}</span>
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {t("nav.systemStatus")}
              </span>
            </span>
          </a>
          <nav className="flex items-center gap-1" aria-label={t("nav.systemStatus")}>
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <a href="#services">{t("nav.services")}</a>
            </Button>
            <Button asChild variant="ghost" size="sm" className="hidden md:inline-flex">
              <a href="#history">{t("nav.history")}</a>
            </Button>
            <Button size="sm" onClick={openSubscription}>
              <BellIcon aria-hidden />
              {t("nav.subscribe")}
            </Button>
          </nav>
        </div>
      </header>

      <div id="top" className="relative mx-auto max-w-6xl px-4 sm:px-6">
        <section className="grid grid-flow-dense grid-cols-1 border-b py-16 md:grid-cols-12 md:py-28">
          <motion.div
            {...reveal}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className="relative pr-0 md:col-span-7 md:pr-12"
          >
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Badge variant="outline" className="font-normal">
                {t("previewData")}
              </Badge>
              <span>{t("hero.eyebrow")}</span>
            </div>
            <h1 className="mt-8 max-w-4xl text-balance text-[clamp(2.65rem,6vw,5.3rem)] leading-[0.98] font-semibold tracking-[-0.055em]">
              {t("hero.title")}
            </h1>
            <p className="mt-6 max-w-2xl text-pretty text-base leading-7 text-muted-foreground md:text-lg">
              {t("hero.description")}
            </p>
            <div
              role="status"
              aria-live="polite"
              className={cn(
                "mt-10 inline-flex items-center gap-3 rounded-full px-4 py-2.5 ring-1",
                overallStyle.soft,
                overallStyle.text
              )}
            >
              <OverallIcon className="size-5" aria-hidden />
              <span className="font-medium">{t(`statuses.overall.${overallStatus}`)}</span>
            </div>
          </motion.div>

          <motion.div
            {...reveal}
            transition={{ duration: 0.4, delay: reducedMotion ? 0 : 0.08, ease: "easeOut" }}
            className="relative mt-12 flex min-h-72 flex-col justify-between border-t pt-8 md:col-span-5 md:mt-0 md:min-h-0 md:border-t-0 md:border-l md:pt-0 md:pl-12"
          >
            <div
              aria-hidden
              className="absolute -top-24 -right-20 size-72 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--chart-2)_18%,transparent),transparent_68%)] blur-2xl"
            />
            <div className="relative flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">{t("hero.uptimeLabel")}</span>
              <GaugeIcon className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <div className="relative">
              <div className="font-mono text-[clamp(3.25rem,8vw,6.5rem)] leading-none font-medium tracking-[-0.08em] tabular-nums">
                {t("hero.uptimeValue", { value: platformUptime.toFixed(2) })}
              </div>
              <div className="mt-6 grid grid-cols-[repeat(18,minmax(0,1fr))] gap-1" aria-hidden>
                {Array.from({ length: 54 }, (_, index) => (
                  <span
                    key={index}
                    className={cn(
                      "h-1.5 rounded-full bg-muted-foreground/20",
                      index > 47 && "bg-amber-500/80"
                    )}
                  />
                ))}
              </div>
              <p className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
                <Clock3Icon className="size-4" aria-hidden />
                {t("hero.lastUpdated", { date: formatTimestamp(snapshot.generatedAt, locale) })}
              </p>
            </div>
          </motion.div>
        </section>

        <section id="services" className="scroll-mt-24 py-16 md:py-24">
          <SectionHeading
            icon={ActivityIcon}
            title={t("serviceHealth.title")}
            description={t("serviceHealth.description")}
          />
          <motion.div
            {...reveal}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="mt-10"
          >
            {snapshot.components.map((component, index) => (
              <ServiceRow
                key={component.id}
                component={component}
                locale={locale}
                isLast={index === snapshot.components.length - 1}
              />
            ))}
          </motion.div>
          <StatusLegend />
        </section>

        <section className="grid grid-flow-dense grid-cols-1 gap-5 py-16 md:grid-cols-12 md:py-24">
          <div className="md:col-span-7">
            <SectionHeading icon={RadioTowerIcon} title={t("activeIncidents.title")} />
            <div className="mt-8">
              {snapshot.activeIncidents.length === 0 ? (
                <div className="border-y py-8 text-sm text-muted-foreground">
                  {t("activeIncidents.empty")}
                </div>
              ) : (
                snapshot.activeIncidents.map((incident) => (
                  <ActiveIncident key={incident.id} incident={incident} locale={locale} />
                ))
              )}
            </div>
          </div>

          <aside className="md:col-span-5 md:pt-0">
            <SectionHeading icon={CalendarClockIcon} title={t("maintenance.title")} />
            <div className="mt-8">
              {snapshot.scheduledMaintenance.map((maintenance) => (
                <article key={maintenance.id} className="border-y py-6">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 text-sky-700 dark:text-sky-300">
                      <WrenchIcon className="size-4" aria-hidden />
                    </span>
                    <div>
                      <h3 className="font-medium">{t(`maintenance.${maintenance.id}.title`)}</h3>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">
                        {t(`maintenance.${maintenance.id}.description`)}
                      </p>
                    </div>
                  </div>
                  <p className="mt-5 border-t pt-4 font-mono text-xs text-muted-foreground tabular-nums">
                    {t("maintenance.window", {
                      start: formatTimestamp(maintenance.startsAt, locale),
                      end: formatTime(maintenance.endsAt, locale),
                    })}
                  </p>
                </article>
              ))}
            </div>
          </aside>
        </section>

        <section id="history" className="scroll-mt-24 py-16 md:py-24">
          <SectionHeading icon={Clock3Icon} title={t("history.title")} />
          <div className="mt-8 divide-y border-y">
            {snapshot.pastIncidents.map((incident) => (
              <PastIncident key={incident.id} incident={incident} locale={locale} />
            ))}
          </div>
        </section>

        <footer className="py-16 md:py-24">
          <div className="relative overflow-hidden border-y bg-foreground px-0 py-10 text-background md:py-14">
            <div
              aria-hidden
              className="absolute right-0 bottom-0 size-80 translate-x-1/3 translate-y-1/3 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--chart-2)_38%,transparent),transparent_68%)] blur-2xl"
            />
            <div className="relative flex flex-col items-start justify-between gap-8 px-5 md:flex-row md:items-end md:px-10">
              <div className="max-w-2xl">
                <p className="text-sm text-background/60">{t("footer.eyebrow")}</p>
                <h2 className="mt-3 max-w-2xl text-balance text-3xl font-semibold tracking-tight md:text-5xl">
                  {t("footer.title")}
                </h2>
                <p className="mt-4 text-background/65">{t("footer.description")}</p>
              </div>
              <Button
                variant="secondary"
                size="lg"
                className="bg-background text-foreground hover:bg-background/90"
                onClick={openSubscription}
              >
                <BellIcon aria-hidden />
                {t("nav.subscribe")}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>{t("brand")}</span>
            <span>{t("footer.legal")}</span>
          </div>
        </footer>
      </div>

      <Dialog open={subscriptionOpen} onOpenChange={setSubscriptionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("subscribe.title")}</DialogTitle>
            <DialogDescription>{t("subscribe.description")}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              setSubscriptionSubmitted(true)
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="public-status-email">{t("subscribe.email")}</Label>
              <Input
                id="public-status-email"
                type="email"
                required
                placeholder={t("subscribe.emailPlaceholder")}
              />
            </div>
            {subscriptionSubmitted && (
              <p
                role="status"
                className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
              >
                {t("subscribe.result")}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSubscriptionOpen(false)}>
                {t("subscribe.cancel")}
              </Button>
              <Button type="submit">{t("subscribe.preview")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function ServiceRow({
  component,
  locale,
  isLast,
}: {
  component: StatusComponent
  locale: string
  isLast: boolean
}) {
  const t = useTranslations("publicStatus")
  const [open, setOpen] = useState(false)
  const name = t(`components.${component.id}.name`)
  const uptime = calculateUptime(component.history)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("group/service border-t", isLast && "border-b")}
    >
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-medium tracking-tight">{name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(`components.${component.id}.description`)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusLabel status={component.status} />
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t(open ? "details.hide" : "details.show", { component: name })}
              >
                <ChevronDownIcon
                  className={cn("transition-transform duration-200", open && "rotate-180")}
                  aria-hidden
                />
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>

        <div className="mt-5">
          <div className="grid grid-cols-[repeat(90,minmax(2px,1fr))] gap-px sm:gap-0.5">
            {component.history.map((day) => {
              const dayLabel = t("availability.dayLabel", {
                component: name,
                date: formatDate(day.date, locale),
                status: t(`statuses.${day.status}`),
                uptime: day.availabilityPercent.toFixed(2),
              })
              return (
                <span
                  key={day.date}
                  role="img"
                  aria-label={dayLabel}
                  title={dayLabel}
                  data-testid="availability-day"
                  className={cn(
                    "h-7 min-w-0 rounded-[2px] opacity-90 transition-opacity hover:opacity-70",
                    STATUS_STYLES[day.status].dot
                  )}
                />
              )
            })}
          </div>
          <div className="mt-2 flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span>{t("availability.from")}</span>
            <span className="font-mono tabular-nums">
              {t("availability.uptime", { value: uptime.toFixed(2) })}
            </span>
            <span>{t("availability.today")}</span>
          </div>
        </div>
      </div>

      <CollapsibleContent>
        <div className="grid gap-6 border-t bg-muted/15 p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(15rem,1fr)]">
          <div>
            <h4 className="text-sm font-medium">{t("details.latency")}</h4>
            <div className="mt-4 h-44 w-full" aria-label={t("details.latency")} role="img">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <AreaChart
                  data={component.latency24h}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id={`latency-${component.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.55} />
                  <XAxis dataKey="at" hide />
                  <YAxis hide domain={["dataMin - 12", "dataMax + 12"]} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "0.625rem",
                      border: "1px solid var(--border)",
                      background: "var(--background)",
                      color: "var(--foreground)",
                      fontSize: "0.75rem",
                    }}
                    labelFormatter={(value) => formatTimestamp(String(value), locale)}
                    formatter={(value) => [
                      t("details.latencyValue", { value: Number(value) }),
                      t("details.latency"),
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="valueMs"
                    stroke="var(--chart-2)"
                    strokeWidth={2}
                    fill={`url(#latency-${component.id})`}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <h4 className="text-sm font-medium">{t("details.regions")}</h4>
            <div className="mt-4 divide-y border-y">
              {component.regions.map((region) => (
                <div key={region.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className={cn("size-2 rounded-full", STATUS_STYLES[region.status].dot)} />
                    {t(`regions.${region.id}`)}
                    <span className="sr-only">{t(`statuses.${region.status}`)}</span>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {t("details.latencyValue", { value: region.latencyMs })}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {t("details.lastChecked", {
                date: formatTimestamp(component.lastCheckedAt, locale),
              })}
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ActiveIncident({ incident, locale }: { incident: Incident; locale: string }) {
  const t = useTranslations("publicStatus")
  return (
    <article aria-label={t(`incidents.${incident.id}.title`)} className="border-y">
      <div className="border-b py-5 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold tracking-tight">
            {t(`incidents.${incident.id}.title`)}
          </h3>
          <StatusLabel status={incident.impact} />
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t(`incidents.${incident.id}.description`)}
        </p>
      </div>
      <ol className="relative space-y-0 py-5 sm:py-6">
        {sortIncidentUpdatesNewestFirst(incident.updates).map((update, index, updates) => (
          <li key={update.id} className="relative grid grid-cols-[auto_1fr] gap-4 pb-6 last:pb-0">
            {index < updates.length - 1 && (
              <span aria-hidden className="absolute top-4 bottom-0 left-[5px] w-px bg-border" />
            )}
            <span
              aria-hidden
              className={cn(
                "relative z-10 mt-1.5 size-3 rounded-full border-2 border-background",
                STATUS_STYLES[update.state === "resolved" ? "operational" : incident.impact].dot
              )}
            />
            <div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span data-testid="incident-update-state" className="text-sm font-medium">
                  {t(`incidentStates.${update.state}`)}
                </span>
                <time
                  dateTime={update.at}
                  className="font-mono text-xs text-muted-foreground tabular-nums"
                >
                  {formatTimestamp(update.at, locale)}
                </time>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t(`incidents.${incident.id}.updates.${update.id}`)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </article>
  )
}

function PastIncident({ incident, locale }: { incident: Incident; locale: string }) {
  const t = useTranslations("publicStatus")
  const durationMinutes = useMemo(() => {
    if (!incident.resolvedAt) return 0
    return Math.round((Date.parse(incident.resolvedAt) - Date.parse(incident.startedAt)) / 60_000)
  }, [incident.resolvedAt, incident.startedAt])

  return (
    <article className="grid gap-4 py-5 sm:grid-cols-[9rem_1fr_auto] sm:items-start sm:py-6">
      <time
        dateTime={incident.startedAt}
        className="font-mono text-xs text-muted-foreground tabular-nums"
      >
        {formatDate(incident.startedAt, locale)}
      </time>
      <div>
        <h3 className="font-medium">{t(`incidents.${incident.id}.title`)}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t(`incidents.${incident.id}.description`)}
        </p>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">
        <StatusLabel status="operational" label={t("incidentStates.resolved")} />
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {t("history.duration", { minutes: durationMinutes })}
        </span>
      </div>
    </article>
  )
}

function StatusLabel({ status, label }: { status: ServiceStatus; label?: string }) {
  const t = useTranslations("publicStatus")
  const style = STATUS_STYLES[status]
  const Icon = style.icon
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", style.text)}>
      <Icon className="size-3.5" aria-hidden />
      {label ?? t(`statuses.${status}`)}
    </span>
  )
}

function StatusLegend() {
  const t = useTranslations("publicStatus")
  return (
    <div
      aria-label={t("availability.legend")}
      className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"
    >
      {STATUS_ORDER.map((status) => (
        <span key={status} className="inline-flex items-center gap-2">
          <span className={cn("size-2 rounded-full", STATUS_STYLES[status].dot)} aria-hidden />
          {t(`statuses.${status}`)}
        </span>
      ))}
    </div>
  )
}

function SectionHeading({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof ActivityIcon
  title: string
  description?: string
}) {
  return (
    <div className="flex max-w-3xl items-start gap-3">
      <span className="mt-1 text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </span>
      <div>
        <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h2>
        {description && (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
    </div>
  )
}

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value))
}

function formatTimestamp(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value))
}

function formatTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value))
}
