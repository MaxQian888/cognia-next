---
"cognia-next": patch
---

Plugin Media API: every image adjustment it advertises now actually runs. `ImageAdjustmentOptions` has offered eleven controls since it shipped, but only brightness, contrast, saturation and hue were implemented. Exposure, gamma, vibrance, temperature, tint, blur and sharpen were accepted and silently discarded, so a plugin could set them, see no error, and get its input back unchanged. Contrast was also wrong: past roughly plus or minus 40 its curve produced a negative factor, which inverted the image and then clipped it to pure black and white. All eleven are implemented and contrast now scales distance from mid grey linearly. Image loading, resizing, transforms and encoding move to a shared engine so plugins and the app produce identical pixels for identical settings.
