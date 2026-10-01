"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { acpTerminalOutput } from "@/lib/native/external-agent"
import { openUrl } from "@/lib/native/opener"
import type { AcpAuthMethod, AcpTerminalAuthState } from "@/types/agent/external-agent"

export interface ExternalAgentAuthenticationProps {
  agentId: string
  methods: AcpAuthMethod[]
  connected: boolean
  busy?: boolean
  supportsLogout?: boolean
  onBusyChange?: (busy: boolean) => void
  authenticate: (methodId: string) => Promise<void>
  getTerminalAuthState: () => AcpTerminalAuthState | undefined
  cancelTerminalAuthentication: () => Promise<void>
  logout: () => Promise<void>
}

/** Native terminal authentication remains agent-owned; output never enters chat history. */
export function ExternalAgentAuthentication(props: ExternalAgentAuthenticationProps) {
  return <AuthenticationSession key={props.agentId} {...props} />
}

function AuthenticationSession(props: ExternalAgentAuthenticationProps) {
  const t = useTranslations("externalAgent.authentication")
  const [state, setState] = useState<AcpTerminalAuthState>()
  const [output, setOutput] = useState("")
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const [signedOut, setSignedOut] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const generation = useRef(0)
  const authRunning = useRef(false)
  const actionRunning = useRef(false)
  const callbacks = useRef(props)
  const translate = useRef(t)
  useEffect(() => {
    callbacks.current = props
    translate.current = t
  }, [props, t])

  useEffect(() => {
    const scope = ++generation.current
    const cancel = callbacks.current.cancelTerminalAuthentication
    const onBusyChange = callbacks.current.onBusyChange
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (stopped) return
      const current = callbacks.current.getTerminalAuthState()
      setState(current)
      if (
        current?.terminalId &&
        (current.status === "running" || current.status === "reconnecting")
      ) {
        try {
          const result = await acpTerminalOutput(current.terminalId, 64 * 1024)
          if (!stopped && generation.current === scope) {
            setOutput(result.output)
            setError(undefined)
          }
        } catch {
          // The adapter releases the terminal when login settles. Keep its last output.
          if (!stopped && callbacks.current.getTerminalAuthState()?.status === "running") {
            setError(translate.current("outputUnavailable"))
          }
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 300)
    }
    timer = setTimeout(() => void poll(), 0)
    return () => {
      stopped = true
      generation.current = scope + 1
      if (timer) clearTimeout(timer)
      if (authRunning.current) void cancel().catch(() => undefined)
      authRunning.current = false
      onBusyChange?.(false)
    }
  }, [props.agentId])

  const run = async (action: () => Promise<void>, authentication: boolean) => {
    const scope = generation.current
    if (actionRunning.current || props.busy || !props.connected) return
    actionRunning.current = true
    setPending(true)
    setError(undefined)
    setOutput("")
    setState(undefined)
    if (authentication) setSignedOut(false)
    props.onBusyChange?.(true)
    authRunning.current = authentication
    try {
      await action()
      if (generation.current !== scope) return
      setState(props.getTerminalAuthState())
      setSignedOut(!authentication)
    } catch (cause) {
      if (generation.current === scope)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation.current === scope) {
        authRunning.current = false
        actionRunning.current = false
        setPending(false)
        props.onBusyChange?.(false)
      }
    }
  }

  const terminalMethods = props.methods.filter((method) => method.type === "terminal")
  if (!terminalMethods.length && !props.supportsLogout) return null
  const cancellable = state?.status === "starting" || state?.status === "running"
  const disabled = props.busy || pending || !props.connected
  const cleanOutput = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  const loginUrls = [...new Set(cleanOutput.match(/https:\/\/[^\s<>"\x1b]+/g) ?? [])]
  return (
    <section className="space-y-2 rounded-md border p-3" aria-label={t("title")}>
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="text-xs text-muted-foreground" role="status">
        {signedOut ? t("signedOut") : state ? t(`status.${state.status}`) : t("unknown")}
      </p>
      <div className="flex flex-wrap gap-2">
        {terminalMethods.map((method) => (
          <Button
            key={method.id}
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void run(() => props.authenticate(method.id), true)}
          >
            {t("login", { method: method.name })}
          </Button>
        ))}
        {pending && cancellable && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const scope = generation.current
              void props.cancelTerminalAuthentication().catch((cause: unknown) => {
                if (generation.current === scope)
                  setError(cause instanceof Error ? cause.message : String(cause))
              })
            }}
          >
            {t("cancelLogin")}
          </Button>
        )}
        {props.supportsLogout && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || signedOut}
            onClick={() => setConfirmLogout(true)}
          >
            {t("logout")}
          </Button>
        )}
      </div>
      {output && (
        <pre
          className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs"
          aria-label={t("terminalOutput")}
        >
          {cleanOutput}
        </pre>
      )}
      {loginUrls.map((url) => (
        <Button
          key={url}
          size="sm"
          variant="link"
          className="max-w-full truncate"
          onClick={() => {
            const scope = generation.current
            void openUrl(url).catch((cause: unknown) => {
              if (generation.current === scope)
                setError(cause instanceof Error ? cause.message : String(cause))
            })
          }}
        >
          {t("openLoginPage", { url })}
        </Button>
      ))}
      {(error || state?.error) && (
        <p role="alert" className="text-xs text-destructive">
          {error || state?.error}
        </p>
      )}
      <AlertDialog open={confirmLogout} onOpenChange={setConfirmLogout}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("logoutTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("logoutDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("keepAccount")}</AlertDialogCancel>
            <AlertDialogAction disabled={disabled} onClick={() => void run(props.logout, false)}>
              {t("logout")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
