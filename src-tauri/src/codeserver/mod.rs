//! Desktop command/window adapters around the shared IDE runtime.
pub use cognia_codeserver::*;
pub mod commands;
pub mod webview;

pub use cognia_companion_rpc::codeserver_host::install_host;

#[cfg(test)]
mod tests {
    #[test]
    fn both_binaries_install_the_ide_host() {
        assert!(
            include_str!("../startup/services.rs").contains("crate::codeserver::install_host()")
        );
        assert!(
            include_str!("../../../crates/cognia-companion-rpc/src/headless.rs")
                .contains("crate::codeserver_host::install_host()")
        );
    }
}
