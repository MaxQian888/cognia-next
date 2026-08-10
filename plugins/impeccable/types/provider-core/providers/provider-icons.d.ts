interface ProviderIconInfo {
  name: string
  localIcon: string
  brandColor: string
  hasLocalIcon: boolean
}
declare function getProviderIconInfo(providerId: string): ProviderIconInfo
declare function getProviderIconPath(providerId: string): string

export { type ProviderIconInfo, getProviderIconInfo, getProviderIconPath }
