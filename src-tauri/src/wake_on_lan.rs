//! Tauri facade for Wake-on-LAN.
//!
//! The magic packet lives in `cognia_companion_connectivity::wake_on_lan` and
//! is glob-re-exported here, so `crate::wake_on_lan::…` paths resolve
//! unchanged (ADR-0196). The renderer's command stays in the app.

pub use cognia_companion_connectivity::wake_on_lan::*;

/// Send a magic packet to a paired host that the connectivity ladder could not
/// reach. Best-effort by contract: success means the packet left this machine,
/// not that anything woke up.
#[tauri::command]
pub async fn wake_paired_host(mac: String, broadcast: Option<String>) -> Result<(), String> {
    wake(&mac, broadcast.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_command_refuses_what_wake_refuses() {
        assert!(wake_paired_host("not-a-mac".into(), None).await.is_err());
        assert!(
            wake_paired_host("aa:bb:cc:dd:ee:ff".into(), Some("not-an-ip".into()))
                .await
                .is_err()
        );
    }

    #[test]
    fn the_command_is_registered_with_the_tauri_invoke_handler() {
        let source = include_str!("lib.rs");
        let production_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("production lib.rs source");
        assert!(production_source.contains("wake_on_lan::wake_paired_host,"));
    }
}
