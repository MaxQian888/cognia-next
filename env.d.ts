declare namespace NodeJS {
  interface ProcessEnv {
    /** Display name for the app. Required. */
    NEXT_PUBLIC_APP_NAME?: string
    /** Base URL for an external API. Optional. */
    NEXT_PUBLIC_API_URL?: string
    /** WebRTC signaling rendezvous endpoint (ADR-0021). Optional; defaults to wss://signaling.cognia.cn/v1/signaling. */
    NEXT_PUBLIC_SIGNALING_URL?: string
    /** ADR-0059 C1 — cognia-server URL baked into the web build; makes the
     * plain browser a cloud companion (pair page + companion transport). */
    NEXT_PUBLIC_COGNIA_SERVER_URL?: string
    /** Public share-link service endpoint (ADR-0037). Optional; defaults to https://share.cognia.cn. */
    NEXT_PUBLIC_SHARE_URL?: string
  }
}
