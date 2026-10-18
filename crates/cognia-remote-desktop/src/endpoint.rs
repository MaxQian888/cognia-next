//! Resolve a user-supplied endpoint once and pin it (ADR-0234 §4). The bridge
//! dials only the pinned address, so a later DNS answer cannot redirect a
//! session; re-resolution is used only to notice that the name moved.

use crate::{
    error::{RemoteDesktopError, Result},
    target::EndpointClass,
};
use cognia_net::egress::{classify_dest, DestClass};
use std::{
    future::Future,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

pub const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pinned {
    pub ip: IpAddr,
    pub class: EndpointClass,
}

/// Resolve with the system resolver.
pub async fn pin(host: &str, port: u16) -> Result<Pinned> {
    pin_with(host, port, |host, port| async move {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map(|addrs| addrs.collect::<Vec<_>>())
    })
    .await
}

/// The first address of a dialable answer is pinned.
pub async fn pin_with<F, Fut>(host: &str, port: u16, resolve: F) -> Result<Pinned>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: Future<Output = std::io::Result<Vec<SocketAddr>>>,
{
    let first = resolve_with(host, port, resolve).await?[0];
    let class = match classify_dest(&first) {
        DestClass::Private => EndpointClass::Private,
        DestClass::Public => EndpointClass::Public,
        DestClass::Forbidden => unreachable!("forbidden answers are refused by resolve_with"),
    };
    Ok(Pinned { ip: first, class })
}

/// Whether the name still resolves to the pinned address. Round-robin answers
/// may reorder, so membership, not position, is what counts.
pub async fn still_pinned_with<F, Fut>(host: &str, port: u16, pinned: IpAddr, resolve: F) -> Result<bool>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: Future<Output = std::io::Result<Vec<SocketAddr>>>,
{
    Ok(resolve_with(host, port, resolve).await?.contains(&pinned))
}

/// Every address in the answer must be dialable: one forbidden address (a
/// rebinding answer mixing a LAN address with 127.0.0.1 or metadata) refuses
/// the whole name. Never empty on success.
pub async fn resolve_with<F, Fut>(host: &str, port: u16, resolve: F) -> Result<Vec<IpAddr>>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: Future<Output = std::io::Result<Vec<SocketAddr>>>,
{
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<IpAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => tokio::time::timeout(RESOLVE_TIMEOUT, resolve(host.to_owned(), port))
            .await
            .map_err(|_| RemoteDesktopError::new("remote_desktop_resolve_timeout"))?
            .map_err(|_| RemoteDesktopError::new("remote_desktop_resolve_failed"))?
            .into_iter()
            .map(|addr| addr.ip())
            .collect(),
    };
    if addresses.is_empty() {
        return Err(RemoteDesktopError::new("remote_desktop_resolve_failed"));
    }
    if addresses
        .iter()
        .any(|ip| classify_dest(ip) == DestClass::Forbidden)
    {
        return Err(RemoteDesktopError::new("remote_desktop_endpoint_forbidden"));
    }
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(ips: &'static [&'static str]) -> impl FnOnce(String, u16) -> std::future::Ready<std::io::Result<Vec<SocketAddr>>> {
        move |_, port| {
            std::future::ready(Ok(ips
                .iter()
                .map(|ip| SocketAddr::new(ip.parse().unwrap(), port))
                .collect()))
        }
    }

    #[tokio::test]
    async fn literal_addresses_are_classified_without_resolution() {
        let pinned = pin_with("192.168.1.5", 5900, |_, _| async {
            panic!("a literal must not be resolved")
        })
        .await
        .unwrap();
        assert_eq!(pinned.class, EndpointClass::Private);
        let v6 = pin_with("[fd00::5]", 5900, answer(&[])).await.unwrap();
        assert_eq!(v6.ip, "fd00::5".parse::<IpAddr>().unwrap());
        assert_eq!(
            pin_with("127.0.0.1", 5900, answer(&[])).await.unwrap_err().code,
            "remote_desktop_endpoint_forbidden"
        );
    }

    #[tokio::test]
    async fn the_first_address_is_pinned_and_any_forbidden_answer_refuses_the_name() {
        let pinned = pin_with("nas.local", 5900, answer(&["192.168.1.9", "192.168.1.10"]))
            .await
            .unwrap();
        assert_eq!(pinned.ip, "192.168.1.9".parse::<IpAddr>().unwrap());
        let public = pin_with("vnc.example", 5900, answer(&["8.8.4.4"])).await.unwrap();
        assert_eq!(public.class, EndpointClass::Public);
        for rebinding in [&["192.168.1.9", "127.0.0.1"][..], &["169.254.169.254"][..]] {
            let leaked: &'static [&'static str] = Box::leak(rebinding.to_vec().into_boxed_slice());
            assert_eq!(
                pin_with("evil.example", 5900, answer(leaked)).await.unwrap_err().code,
                "remote_desktop_endpoint_forbidden"
            );
        }
        assert_eq!(
            pin_with("empty.example", 5900, answer(&[])).await.unwrap_err().code,
            "remote_desktop_resolve_failed"
        );
        assert_eq!(
            pin_with("broken.example", 5900, |_, _| async {
                Err(std::io::Error::other("nxdomain"))
            })
            .await
            .unwrap_err()
            .code,
            "remote_desktop_resolve_failed"
        );
    }

    #[tokio::test]
    async fn a_reordered_answer_still_holds_the_pin_and_a_moved_name_does_not() {
        let pinned: IpAddr = "192.168.1.9".parse().unwrap();
        assert!(still_pinned_with("nas.local", 5900, pinned, answer(&["192.168.1.10", "192.168.1.9"]))
            .await
            .unwrap());
        assert!(!still_pinned_with("nas.local", 5900, pinned, answer(&["192.168.1.77"]))
            .await
            .unwrap());
        assert_eq!(
            still_pinned_with("nas.local", 5900, pinned, answer(&["192.168.1.9", "127.0.0.1"]))
                .await
                .unwrap_err()
                .code,
            "remote_desktop_endpoint_forbidden"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_hung_resolver_times_out() {
        let error = pin_with("slow.example", 5900, |_, _| std::future::pending())
            .await
            .unwrap_err();
        assert_eq!(error.code, "remote_desktop_resolve_timeout");
    }
}
