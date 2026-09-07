/**
 * Platforms this app can reach over exactly one inbound transport, and why.
 *
 * Every one of these looks identical in the product today: the row offers no
 * transport choice, the tunnel tab prints "no public URL needed", and nothing
 * anywhere says whether that is a fact about the platform or a gap in this
 * app. Those are different answers with different remedies. One means a
 * network that blocks the connection leaves the operator with nothing to try.
 * The other means there is a second path that simply has not been built.
 *
 * Recorded as data so the UI can print the honest reason and
 * `single-transport-platforms.test.ts` can pin it, which is CLAUDE.md working
 * rule 7: documented at the type, labelled in the UI, and held by a test.
 * Any two of the three is a latent bug.
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"

/**
 * Why there is only one.
 *
 * `protocol` is a statement about the platform. `unbuilt` is a statement about
 * this app, and is the one that belongs in a backlog rather than in a
 * limitation notice.
 */
export type SingleTransportCause = "protocol" | "unbuilt"

export interface SingleTransportPlatform {
  /** The one transport that exists for this platform here. */
  transport: "longpoll" | "gateway"
  cause: SingleTransportCause
  /**
   * i18n key fragment under `settings.connections.singleTransport`, resolved
   * at render time so this module stays pure data with no next-intl edge.
   */
  reasonKey: string
}

export const SINGLE_TRANSPORT_PLATFORMS: Readonly<
  Partial<Record<PlatformKind, SingleTransportPlatform>>
> = {
  /**
   * Matrix delivers events by long-polling `/sync` on the homeserver. The
   * client-server API has no inbound webhook to register: `/sync` IS the
   * transport, and Application Services, which do push, are a server-side
   * deployment rather than something a client can opt into.
   */
  matrix: { transport: "longpoll", cause: "protocol", reasonKey: "matrix" },
  /**
   * Personal WeChat has no official inbound API at all. Messages arrive over
   * the iLink bridge this app long-polls, and there is no endpoint Tencent
   * would ever call.
   */
  "wechat-personal": { transport: "longpoll", cause: "protocol", reasonKey: "wechatPersonal" },
  /**
   * WeCom DOES publish an HTTP callback with the WXBizMsgCrypt scheme, and
   * `sigverify/wechat.rs` already implements that scheme for WeChat OA. Only
   * the gateway path is built here, so a blocked socket currently has no
   * fallback even though the platform offers one.
   */
  wecom: { transport: "gateway", cause: "unbuilt", reasonKey: "wecom" },
  /**
   * DingTalk publishes an HTTP callback alongside Stream mode. Only Stream is
   * built here, so this is the same shape of gap as WeCom.
   */
  dingtalk: { transport: "gateway", cause: "unbuilt", reasonKey: "dingtalk" },
}

/** The single-transport record for `kind`, or undefined when it has a choice. */
export function singleTransportPlatform(kind: string): SingleTransportPlatform | undefined {
  return SINGLE_TRANSPORT_PLATFORMS[kind as PlatformKind]
}
