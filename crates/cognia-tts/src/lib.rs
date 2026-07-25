// TTS Tauri-side bridge. See sibling modules:
//   - keyring: OS-keyring storage of provider API keys.
//   - edge:    WebSocket bridge to Edge-TTS (replaces /api/tts/edge).
//   - proxy:   Generic HTTP proxy for cloud-provider REST calls that fail
//              under browser CORS or whose secret keys must stay in Rust.
//
// Note: `#[tauri::command]` generates a sibling `__cmd__<fn>` symbol in the
// *defining* module, so `generate_handler!` in lib.rs uses the fully
// qualified `tts::keyring::*` / `tts::edge::*` / `tts::proxy::*` paths.
// Plain `pub use` re-exports do not carry the cmd marker.

pub mod edge;
pub mod keyring;
pub mod live;
pub mod proxy;
pub mod realtime;
