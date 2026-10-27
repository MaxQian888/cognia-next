//! Shared wasmtime `Engine` + the background epoch ticker.
//!
//! Every WASM plugin instance shares one `Engine` (compilation cache).
//! Each instance gets its own `Store<HostState>`. The ticker is a single
//! process-lifetime thread that calls `engine.increment_epoch()` every 100 ms; combined
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

/// A process-wide ticker must outlive individual async runtimes and must also
/// start when the engine is first used by a synchronous caller.
fn spawn_epoch_ticker(engine: Engine) {
    std::thread::Builder::new()
        .name("cognia-wasm-epoch".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(EPOCH_TICK_MS));
            engine.increment_epoch();
        })
        .expect("start WASM epoch ticker");
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
            // The parent parser has already advanced past this section, but
            // its payload bytes remain in `buf`. Only the OUTER component's
            // version is authoritative; skip nested binaries in full.
            wasmparser::Payload::ModuleSection {
                unchecked_range, ..
            }
            | wasmparser::Payload::ComponentSection {
                unchecked_range, ..
            } => {
                let len = (unchecked_range.end - unchecked_range.start) as usize;
                buf = buf
                    .get(len..)
                    .ok_or_else(|| wasmtime::Error::msg("truncated nested WASM section"))?;
            }
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
    fn epoch_ticker_runs_without_an_async_runtime() {
        let engine = build_engine().unwrap();
        spawn_epoch_ticker(engine.clone());
        let worker_engine = engine.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            // Minimal core module exporting a function that loops forever.
            let binary = b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x07\x08\x01\x04spin\0\0\x0a\x09\x01\x07\0\x03\x40\x0c\0\x0b\x0b";
            let module = wasmtime::Module::new(&worker_engine, binary).unwrap();
            let mut store = wasmtime::Store::new(&worker_engine, ());
            store.set_epoch_deadline(1);
            let instance = wasmtime::Instance::new(&mut store, &module, &[]).unwrap();
            let spin = instance
                .get_typed_func::<(), ()>(&mut store, "spin")
                .unwrap();
            assert!(spin.call(&mut store, ()).is_err());
            send.send(()).unwrap();
        });
        let automatic = receive.recv_timeout(Duration::from_secs(2)).is_ok();
        if !automatic {
            // A broken ticker must fail the assertion, never hang cargo test.
            engine.increment_epoch();
        }
        worker.join().unwrap();
        assert!(automatic, "epoch checks must tick outside tokio");
    }

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

    fn version_section(version: &str) -> Vec<u8> {
        let mut payload = vec![API_VERSION_SECTION.len() as u8];
        payload.extend_from_slice(API_VERSION_SECTION.as_bytes());
        payload.extend_from_slice(version.as_bytes());
        let mut section = vec![0, payload.len() as u8];
        section.extend(payload);
        section
    }

    #[test]
    fn parse_plugin_api_version_skips_nested_module_and_component_sections() {
        for (section_id, header) in [(1, b"\0asm\x01\0\0\0"), (4, b"\0asm\x0d\0\x01\0")] {
            let mut nested = header.to_vec();
            nested.extend(version_section("9.9.9"));
            let mut component = b"\0asm\x0d\0\x01\0".to_vec();
            component.extend([section_id, nested.len() as u8]);
            component.extend(&nested);
            component.extend(version_section("0.2.0"));
            assert_eq!(parse_plugin_api_version(&component).unwrap(), "0.2.0");
            component.truncate(component.len() - version_section("0.2.0").len());
            assert!(
                parse_plugin_api_version(&component).is_err(),
                "nested versions are not authoritative"
            );
        }
    }

    #[test]
    fn parse_plugin_api_version_rejects_truncated_nested_module() {
        let mut component = b"\0asm\x0d\0\x01\0".to_vec();
        component.extend([1, 20]);
        component.extend(b"\0asm\x01\0\0\0");
        assert!(parse_plugin_api_version(&component).is_err());
    }
}
