// Tauri-side wallpaper IO. Frontend uses these commands when running on
// desktop to persist user-uploaded background images outside of IndexedDB
// (web mode falls back to Blob storage). Files live under
// `<app_data>/cognia/wallpapers/<uuid>.<ext>`. The relative path is what's
// stored in `AppSettings.wallpapers[].source.relPath`; the frontend resolves
// it back to a webview URL via `convertFileSrc` when applying the background.

pub mod commands;
