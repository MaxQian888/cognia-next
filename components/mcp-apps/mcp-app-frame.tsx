"use client"

import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  evaluateMcpAppSandbox,
  injectMcpAppCsp,
  MCP_APP_SANDBOX_PROXY_HTML,
  type McpAppApprovals,
} from "@/lib/mcp/apps-sandbox"

interface McpAppToolResult {
  isError?: boolean
  content: unknown[]
  structuredContent?: unknown
}

interface McpAppServerProvenance {
  serverId: string
  serverName: string
  resourceUri: string
}

export interface McpAppFrameProps {
  html: string
  csp?: McpUiResourceCsp
  permissions?: McpUiResourcePermissions
  approvals: McpAppApprovals
  provenance: McpAppServerProvenance
  toolInput?: Record<string, unknown>
  toolResult?: McpAppToolResult
  authorizeToolCall: (request: {
    name: string
    arguments?: Record<string, unknown>
    provenance: McpAppServerProvenance
  }) => boolean | Promise<boolean>
  callTool: (request: {
    name: string
    arguments?: Record<string, unknown>
    provenance: McpAppServerProvenance
  }) => Promise<McpAppToolResult>
  confirmOpenLink?: (request: {
    url: string
    hostname: string
    provenance: McpAppServerProvenance
  }) => boolean | Promise<boolean>
  openLink?: (url: string) => void | Promise<void>
  confirmDownload?: (request: {
    contents: unknown[]
    provenance: McpAppServerProvenance
  }) => boolean | Promise<boolean>
  quarantineDownload?: (contents: unknown[]) => void | Promise<void>
}

function safeExternalUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined
    if (url.username || url.password) return undefined
    return url
  } catch {
    return undefined
  }
}

export function McpAppFrame(props: McpAppFrameProps) {
  const {
    html,
    csp,
    permissions,
    approvals,
    provenance,
    toolInput,
    toolResult,
    authorizeToolCall,
    callTool,
    confirmOpenLink,
    openLink,
    confirmDownload,
    quarantineDownload,
  } = props
  const t = useTranslations("mcpApps")
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [proxyHtml, setProxyHtml] = useState<string>()
  const [height, setHeight] = useState(360)
  const [runtimeError, setRuntimeError] = useState(false)
  const policy = useMemo(
    () => evaluateMcpAppSandbox(csp, permissions, approvals),
    [approvals, csp, permissions]
  )

  useEffect(() => {
    if (!policy.allowed || !iframeRef.current?.contentWindow) return
    let disposed = false
    let bridge: import("@modelcontextprotocol/ext-apps/app-bridge").AppBridge | undefined

    void import("@modelcontextprotocol/ext-apps/app-bridge")
      .then(async ({ AppBridge, PostMessageTransport }) => {
        if (disposed || !iframeRef.current?.contentWindow) return
        const target = iframeRef.current.contentWindow
        bridge = new AppBridge(
          null,
          { name: "cognia", version: "1.0.0" },
          {
            openLinks: {},
            serverTools: {},
            sandbox: { csp: policy.csp, permissions: policy.permissions },
          }
        )
        bridge.oncalltool = async ({ name, arguments: args }) => {
          const request = { name, arguments: args, provenance }
          if (!(await authorizeToolCall(request))) {
            return { isError: true, content: [] }
          }
          return (await callTool(request)) as never
        }
        bridge.onopenlink = async ({ url: value }) => {
          const url = safeExternalUrl(value)
          if (!url || !confirmOpenLink || !openLink) return { isError: true }
          const approved = await confirmOpenLink({
            url: url.href,
            hostname: url.hostname,
            provenance,
          })
          if (!approved) return { isError: true }
          await openLink(url.href)
          return {}
        }
        bridge.ondownloadfile = async ({ contents }) => {
          if (!confirmDownload || !quarantineDownload) return { isError: true }
          const approved = await confirmDownload({
            contents,
            provenance,
          })
          if (!approved) return { isError: true }
          await quarantineDownload(contents)
          return {}
        }
        bridge.onsizechange = ({ height: requestedHeight }) => {
          if (requestedHeight) setHeight(Math.min(1_200, Math.max(120, requestedHeight)))
        }
        bridge.onsandboxready = () => {
          void bridge?.sendSandboxResourceReady({
            html: injectMcpAppCsp(html, policy.csp),
            sandbox: policy.sandbox,
            csp: policy.csp,
            permissions: policy.permissions,
          })
        }
        bridge.oninitialized = () => {
          if (toolInput) void bridge?.sendToolInput({ arguments: toolInput })
          if (toolResult) void bridge?.sendToolResult(toolResult as never)
        }
        await bridge.connect(new PostMessageTransport(target, target))
        if (!disposed) setProxyHtml(MCP_APP_SANDBOX_PROXY_HTML)
      })
      .catch(() => {
        if (!disposed) setRuntimeError(true)
      })

    return () => {
      disposed = true
      void bridge?.close()
    }
  }, [
    policy,
    authorizeToolCall,
    callTool,
    confirmDownload,
    confirmOpenLink,
    html,
    openLink,
    provenance,
    quarantineDownload,
    toolInput,
    toolResult,
  ])

  if (!policy.allowed) {
    return (
      <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
        {t("approvalRequired")}
      </div>
    )
  }
  if (runtimeError) {
    return (
      <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
        {t("runtimeError")}
      </div>
    )
  }
  return (
    <iframe
      ref={iframeRef}
      title={t("frameTitle", { server: provenance.serverName })}
      sandbox="allow-scripts"
      srcDoc={proxyHtml}
      className="w-full rounded-md border bg-background"
      style={{ height }}
    />
  )
}
