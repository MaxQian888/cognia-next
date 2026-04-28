declare namespace NodeJS {
  interface ProcessEnv {
    /** Display name for the app. Required. */
    NEXT_PUBLIC_APP_NAME?: string
    /** Base URL for an external API. Optional. */
    NEXT_PUBLIC_API_URL?: string
  }
}
