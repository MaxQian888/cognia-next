//! Shared wasmtime `Engine` + the background epoch ticker.
//!
//! Every WASM plugin instance shares one `Engine` (compilation cache).
//! Each instance gets its own `Store<HostState>`. The ticker is a single
//! tokio task that calls `engine.increment_epoch()` every 100 ms; combined
//! with `Store::set_epoch_deadline`, this implements cheap cooperative
//! interruption (~10 % overhead in published wasmtime benchmarks).

use std::sync::OnceLock;
use std::time::Duration;

use wasmtime::{Config, Engine};

use super::API_VERSION_SECTION;

/// Tick interval — fast enough to cancel runaways promptly, slow enough to
/// not burn CPU. Zed uses 100 ms in `crates/extension_host/src/wasm_host.rs`.
pub const EPOCH_TICK_MS: u64 = 100;

static ENGINE: OnceLock<Engine> = OnceLock::new();

/// Returns the process-wide engine, lazily constructing it on first call.
/// Safe to call from any thread; the engine itself is `Send + Sync`.
pub fn engine() -> &'static Engine {
    ENGINE.get_or_init(|| {
        let engine = build_engine().expect("wasmtime engine config is valid");
        spawn_epoch_ticker(engine.clone());
        engine
    })
}

/// Build the wasmtime configuration the cognia host requires. Errors here
/// indicate a programming mistake (incompatible feature combinations), so
/// `engine()` unwraps the result.
fn build_engine() -> wasmtime::Result<Engine> {
    let mut cfg = Config::new();
    cfg.wasm_component_model(true);
    cfg.epoch_interruption(true);
    Engine::new(&cfg)
}

/// Spawn the background ticker that bumps the engine's epoch counter.
/// Detached: dropping the JoinHandle is intentional — the ticker lives
/// for the lifetime of the engine, which is the lifetime of the process.
fn spawn_epoch_ticker(engine: Engine) {
    // The ticker only runs if a tokio runtime is available. In tests
    // (`#[tokio::test]`) it is; in production `tauri::async_runtime`
    // provides one. If neither exists, ticking is a no-op and the only
    // observable effect is that `epoch_deadline` traps stop firing —
    // which is fine, because no one is calling into wasm anyway.
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(EPOCH_TICK_MS));
        loop {
            interval.tick().await;
            engine.increment_epoch();
        }
    });
}

/// Extract the embedded `cognia:api-version` custom-section payload from a
/// component binary. Per ADR 0013 §"ABI versioning" a binary that omits the
/// section is **malformed**: the manifest-declared version is attacker-
/// controlled, so a plugin that fails to stamp the section at build time must
/// be rejected rather than trusted. Errors when the section is absent (or its
/// payload is not UTF-8); returns the trimmed version string otherwise.
pub fn parse_plugin_api_version(bytes: &[u8]) -> wasmtime::Result<String> {
    let mut parser = wasmparser::Parser::new(0);
    let mut buf = bytes;
    loop {
        let payload = match parser.parse(buf, true)? {
            wasmparser::Chunk::NeedMoreData(_) => return Err(missing_section_error()),
            wasmparser::Chunk::Parsed { consumed, payload } => {
                buf = &buf[consumed..];
                payload
            }
        };
        match payload {
            wasmparser::Payload::CustomSection(reader) if reader.name() == API_VERSION_SECTION => {
                let v = String::from_utf8(reader.data().to_vec())
                    .map_err(|e| wasmtime::Error::msg(format!("invalid api-version utf8: {e}")))?;
                return Ok(v.trim().to_string());
            }
            wasmparser::Payload::End(_) => return Err(missing_section_error()),
            _ => continue,
        }
    }
}

fn missing_section_error() -> wasmtime::Error {
    wasmtime::Error::msg(format!(
        "missing `{API_VERSION_SECTION}` custom section — plugin binary is malformed \
         (the manifest-declared api-version is not trusted)"
    ))
}

/// Compare a plugin's declared API version against the host's. v0.x bumps
/// MINOR for breaking changes, so MAJOR + MINOR must match exactly until
/// 1.0; PATCH is always compatible. After 1.0 only MAJOR must match.
pub fn api_version_compatible(plugin: &str, host: &str) -> bool {
    let p = parse_semver(plugin);
    let h = parse_semver(host);
    match (p, h) {
        (Some((pm, pn, _)), Some((hm, hn, _))) => {
            if hm == 0 {
                pm == hm && pn == hn
            } else {
                pm == hm
            }
        }
        _ => false,
    }
}

fn parse_semver(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_is_singleton_per_process() {
        let a = engine() as *const Engine;
        let b = engine() as *const Engine;
        assert_eq!(a, b);
    }

    #[test]
    fn semver_parses_three_components() {
        assert_eq!(parse_semver("0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_semver("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver(" 0.1.0\n"), Some((0, 1, 0)));
        assert_eq!(parse_semver("0.1"), None);
        assert_eq!(parse_semver("garbage"), None);
    }

    #[test]
    fn pre_1_0_locks_minor() {
        assert!(api_version_compatible("0.1.0", "0.1.0"));
        assert!(api_version_compatible("0.1.5", "0.1.0")); // patch ok
        assert!(!api_version_compatible("0.2.0", "0.1.0")); // minor breaks
        assert!(!api_version_compatible("0.0.9", "0.1.0"));
    }

    #[test]
    fn post_1_0_locks_major_only() {
        assert!(api_version_compatible("1.0.0", "1.0.0"));
        assert!(api_version_compatible("1.4.7", "1.0.0"));
        assert!(!api_version_compatible("2.0.0", "1.0.0"));
        assert!(!api_version_compatible("0.9.0", "1.0.0"));
    }

    #[test]
    fn parse_plugin_api_version_rejects_binary_without_section() {
        // A well-formed core-module preamble with no sections: the api-version
        // custom section is absent, so the binary is malformed and must be
        // rejected (ADR-0013) — the manifest-declared version is not trusted.
        let err = parse_plugin_api_version(&[0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).unwrap_err();
        assert!(
            err.to_string().contains(API_VERSION_SECTION),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parse_plugin_api_version_rejects_truncated_binary() {
        // A truncated buffer can't carry the section — it is rejected (either
        // as a wasmparser header error or as a missing-section error). Either
        // way `load` refuses to trust it.
        assert!(parse_plugin_api_version(&[0x00, 0x61]).is_err());
    }

    #[test]
    fn parse_plugin_api_version_reads_the_custom_section() {
        // Hand-build a core module whose only section is the `cognia:api-version`
        // custom section carrying "0.1.0". Layout: magic + version, then a
        // custom section (id 0x00): LEB size, LEB name-len, name bytes, data.
        let name = API_VERSION_SECTION.as_bytes();
        let data = b"0.1.0";
        let mut payload = Vec::new();
        payload.push(name.len() as u8); // name is < 128 bytes → single LEB byte
        payload.extend_from_slice(name);
        payload.extend_from_slice(data);
        let mut bytes = vec![0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
        bytes.push(0x00); // custom section id
        bytes.push(payload.len() as u8); // section size (< 128 → single byte)
        bytes.extend_from_slice(&payload);
        let v = parse_plugin_api_version(&bytes).expect("section parses");
        assert_eq!(v, "0.1.0");
    }
}
