//! Install conforming Cognia plugins straight from a public GitHub repo.
//!
//! Unlike `wasm::installer` (which clones + `cargo component build`s a WASM
//! plugin), this path is **build-free**: it downloads the repo tarball, finds
//! a conforming `plugin.json`, verifies the declared entry artifacts already
//! ship in the repo, and copies the plugin into the install dir. The same
//! destination layout as every other install path
//! (`<install_dir>/<plugin_id>/`) is reused so the manager-side dispatch is
//! unchanged.

pub mod installer;
