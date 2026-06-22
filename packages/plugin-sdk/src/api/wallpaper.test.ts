import * as sdk from "./wallpaper"
import type {
  ApplyPluginWallpapersArgs,
  ApplyPluginWallpapersResult,
  PluginWallpaperContribution,
  RegisteredPluginWallpaper,
  Wallpaper,
  WallpaperAssetResolver,
} from "./wallpaper"

describe("plugin-sdk api/wallpaper", () => {
  it("exposes the authoring helper and wallpaper bridge registry", () => {
    expect(typeof sdk.defineWallpaper).toBe("function")
    expect(typeof sdk.contributionToWallpaper).toBe("function")
    expect(typeof sdk.applyPluginWallpapers).toBe("function")
    expect(typeof sdk.revertPluginWallpapers).toBe("function")
    expect(typeof sdk.listPluginWallpapers).toBe("function")
    expect(typeof sdk.subscribePluginWallpapers).toBe("function")
  })

  it("re-exports wallpaper contribution, bridge, and appearance types", () => {
    const assertTypes = <
      _T extends
        | PluginWallpaperContribution
        | RegisteredPluginWallpaper
        | WallpaperAssetResolver
        | ApplyPluginWallpapersArgs
        | ApplyPluginWallpapersResult
        | Wallpaper,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
