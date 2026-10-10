//! The built-in provider: a WebDAV listener ([`dav`]) and an SFTP listener
//! ([`sftp`]). Both are thin protocol adapters over the gateway — they
//! authenticate a credential, ask [`crate::gateway::authorize`] for every
//! operation, and do the disk or asset I/O the gateway resolved. Neither
//! decides access on its own.

pub mod dav;
pub mod sftp;

use std::sync::Arc;

use crate::audit::Outcome;
use crate::gateway::{self, Caller, Op, Target};
use crate::now_ms;
use crate::store::Store;

/// Counts a transfer's bytes and audits it once, when the handle closes.
pub(crate) struct TransferMeter {
    store: Arc<Store>,
    caller: Caller,
    op: Op,
    target: Target,
    bytes: u64,
    failed: Option<&'static str>,
}

impl TransferMeter {
    pub fn new(store: Arc<Store>, caller: Caller, op: Op, target: Target) -> Self {
        Self {
            store,
            caller,
            op,
            target,
            bytes: 0,
            failed: None,
        }
    }

    pub fn add(&mut self, bytes: usize) {
        self.bytes = self.bytes.saturating_add(bytes as u64);
    }

    pub fn fail(&mut self, reason: &'static str) {
        self.failed.get_or_insert(reason);
    }
}

impl Drop for TransferMeter {
    fn drop(&mut self) {
        let outcome = if self.failed.is_some() {
            Outcome::Failed
        } else {
            Outcome::Allowed
        };
        gateway::record_transfer(
            &self.store,
            now_ms(),
            &self.caller,
            self.op,
            &self.target,
            Some(self.bytes.min(i64::MAX as u64) as i64),
            outcome,
            self.failed,
        );
    }
}

impl std::fmt::Debug for TransferMeter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferMeter")
            .field("op", &self.op)
            .field("path", &self.target.path())
            .field("bytes", &self.bytes)
            .finish()
    }
}

/// The client address to record: behind a tunnel, the address cloudflared
/// reports in `CF-Connecting-IP`, which is only believed when the TCP peer is
/// the local cloudflared process. It is used for backoff and audit, never to
/// grant anything.
pub(crate) fn client_address(
    peer: std::net::SocketAddr,
    behind_tunnel: bool,
    cf_connecting_ip: Option<&str>,
) -> String {
    if behind_tunnel && peer.ip().is_loopback() {
        if let Some(ip) = cf_connecting_ip
            .map(str::trim)
            .and_then(|value| value.parse::<std::net::IpAddr>().ok())
        {
            return ip.to_string();
        }
    }
    peer.ip().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tunnel_header_is_believed_only_from_the_local_tunnel() {
        let local: std::net::SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let lan: std::net::SocketAddr = "192.168.1.9:5000".parse().unwrap();
        assert_eq!(client_address(local, true, Some("203.0.113.7")), "203.0.113.7");
        assert_eq!(client_address(local, false, Some("203.0.113.7")), "127.0.0.1");
        assert_eq!(client_address(lan, true, Some("203.0.113.7")), "192.168.1.9");
        assert_eq!(client_address(local, true, Some("not an ip")), "127.0.0.1");
    }

    #[test]
    fn a_meter_audits_its_bytes_on_drop() {
        let f = crate::gateway::tests::fixture(
            vec![crate::model::Permission::Read],
            vec![("workspace", "src", true)],
        );
        let store = Arc::new(f.store);
        let target = Target::Virtual {
            path: "/".into(),
            children: vec![],
        };
        {
            let mut meter = TransferMeter::new(store.clone(), crate::gateway::tests::caller(), Op::Read, target.clone());
            meter.add(10);
            meter.add(5);
        }
        {
            let mut meter = TransferMeter::new(store.clone(), crate::gateway::tests::caller(), Op::Write, target);
            meter.fail("io");
        }
        let rows = store.list_audit(None, Some("fg_1"), None, 10).unwrap();
        assert_eq!(rows[1].bytes, Some(15));
        assert_eq!(rows[1].outcome, "allowed");
        assert_eq!(rows[0].outcome, "failed");
        assert_eq!(rows[0].reason.as_deref(), Some("io"));
    }
}
