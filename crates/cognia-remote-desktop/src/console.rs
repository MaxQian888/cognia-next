//! Web console links (ADR-0234 Phase 5): the page of the user's own
//! Guacamole or MeshCentral server that opens one machine. Cognia stores the
//! link the user pasted and never a console credential, so a link carrying
//! one is refused rather than stored.

use crate::{
    error::{RemoteDesktopError, Result},
    target::EndpointClass,
};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

pub const MAX_URL_BYTES: usize = 2048;

/// Query keys that carry a login in a URL. Matched case-insensitively in the
/// query and in a fragment's own query (`#/client/x?token=`).
const CREDENTIAL_KEYS: &[&str] = &[
    "token",
    "access_token",
    "id_token",
    "auth",
    "authtoken",
    "login",
    "logintoken",
    "password",
    "passwd",
    "pwd",
    "secret",
];

/// How a console's links are checked. Closed list: a plugin picks one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleProfile {
    /// `…/#/client/<identifier>`.
    Guacamole,
    /// `…?gotonode=<node>` or `?gotodevicename=`; `viewmode=11` opens the desktop.
    Meshcentral,
    /// Any http(s) page.
    Generic,
}

/// A checked console link and the endpoint it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleLink {
    /// Normalized: what is stored and what clients open.
    pub url: String,
    /// Without IPv6 brackets, as the endpoint stores it.
    pub host: String,
    pub port: u16,
    pub https: bool,
}

fn invalid() -> RemoteDesktopError {
    RemoteDesktopError::new("remote_desktop_console_url_invalid")
}

fn has_credential(query: &str) -> bool {
    url::form_urlencoded::parse(query.as_bytes()).any(|(key, _)| {
        let key = key.to_ascii_lowercase();
        CREDENTIAL_KEYS.contains(&key.as_str())
    })
}

/// The checks every opener applies, whatever the profile: http(s), no user
/// info, no login in the query or the fragment's query, bounded length.
pub fn check_open_url(raw: &str) -> Result<Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_BYTES {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "https" | "http") || url.host().is_none() {
        return Err(invalid());
    }
    let fragment_query = url.fragment().and_then(|fragment| fragment.split_once('?')).map(|(_, query)| query);
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some_and(has_credential)
        || fragment_query.is_some_and(has_credential)
    {
        return Err(RemoteDesktopError::new("remote_desktop_console_url_has_credentials"));
    }
    Ok(url)
}

/// Check `raw` for `profile` and normalize it. Whether plain `http` is
/// acceptable depends on where the name resolves: see [`require_transport`].
pub fn parse(raw: &str, profile: ConsoleProfile) -> Result<ConsoleLink> {
    let mut url = check_open_url(raw)?;
    match profile {
        ConsoleProfile::Guacamole => {
            let route = url.fragment().unwrap_or_default();
            let identifier = route
                .strip_prefix("/client/")
                .map(|rest| rest.split_once('?').map_or(rest, |(identifier, _)| identifier))
                .unwrap_or_default();
            if identifier.is_empty()
                || !identifier
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '=' | '%' | '.'))
            {
                return Err(invalid());
            }
        }
        ConsoleProfile::Meshcentral => {
            let mut selects_device = false;
            let mut has_view_mode = false;
            for (key, value) in url.query_pairs() {
                match key.as_ref() {
                    "gotonode" | "gotodevicename" if !value.trim().is_empty() => selects_device = true,
                    "viewmode" => has_view_mode = true,
                    _ => {}
                }
            }
            if !selects_device {
                return Err(invalid());
            }
            if !has_view_mode {
                url.query_pairs_mut().append_pair("viewmode", "11");
            }
        }
        ConsoleProfile::Generic => {}
    }
    let host = match url.host() {
        Some(Host::Domain(domain)) => {
            if !cognia_net::egress::is_valid_hostname(domain) {
                return Err(invalid());
            }
            domain.to_owned()
        }
        Some(Host::Ipv4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) => ip.to_string(),
        None => return Err(invalid()),
    };
    let port = url.port_or_known_default().ok_or_else(invalid)?;
    let https = url.scheme() == "https";
    let url = url.to_string();
    if url.len() > MAX_URL_BYTES {
        return Err(invalid());
    }
    Ok(ConsoleLink { url, host, port, https })
}

/// Plain `http` is accepted only on a LAN address: over the internet it would
/// send the console's own sign-in in clear text.
pub fn require_transport(link: &ConsoleLink, class: EndpointClass) -> Result<()> {
    if link.https || class == EndpointClass::Private {
        Ok(())
    } else {
        Err(RemoteDesktopError::new("remote_desktop_console_url_insecure"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(raw: &str, profile: ConsoleProfile) -> &'static str {
        parse(raw, profile).unwrap_err().code
    }

    #[test]
    fn guacamole_links_need_a_client_route() {
        let link = parse(
            "https://gw.example.com/guacamole/#/client/MQBjAHBvc3RncmVzcWw",
            ConsoleProfile::Guacamole,
        )
        .unwrap();
        assert_eq!(link.host, "gw.example.com");
        assert_eq!(link.port, 443);
        assert!(link.https);
        assert!(link.url.ends_with("#/client/MQBjAHBvc3RncmVzcWw"));
        assert!(parse("https://gw.example.com/#/client/abc?x=1", ConsoleProfile::Guacamole).is_ok());
        assert_eq!(code("https://gw.example.com/guacamole/", ConsoleProfile::Guacamole), "remote_desktop_console_url_invalid");
        assert_eq!(code("https://gw.example.com/#/client/", ConsoleProfile::Guacamole), "remote_desktop_console_url_invalid");
        assert_eq!(code("https://gw.example.com/#/clients/abc", ConsoleProfile::Guacamole), "remote_desktop_console_url_invalid");
        // Anything unusual in the route reaches the store percent-encoded.
        let encoded = parse("https://gw.example.com/#/client/a<b", ConsoleProfile::Guacamole).unwrap();
        assert!(encoded.url.ends_with("#/client/a%3Cb"));
    }

    #[test]
    fn meshcentral_links_select_a_device_and_open_its_desktop() {
        let link = parse(
            "https://mesh.example.com:8443/?gotonode=node%2F%2Fabc%24def",
            ConsoleProfile::Meshcentral,
        )
        .unwrap();
        assert_eq!(link.port, 8443);
        assert!(link.url.ends_with("gotonode=node%2F%2Fabc%24def&viewmode=11"), "{}", link.url);
        let kept = parse("https://mesh.example.com/?viewmode=12&gotodevicename=nas", ConsoleProfile::Meshcentral).unwrap();
        assert!(kept.url.ends_with("?viewmode=12&gotodevicename=nas"));
        assert_eq!(code("https://mesh.example.com/?gotonode=", ConsoleProfile::Meshcentral), "remote_desktop_console_url_invalid");
        assert_eq!(code("https://mesh.example.com/", ConsoleProfile::Meshcentral), "remote_desktop_console_url_invalid");
    }

    #[test]
    fn links_carrying_a_login_are_refused_wherever_it_hides() {
        for raw in [
            "https://user:pw@mesh.example.com/?gotonode=n",
            "https://mesh.example.com/?gotonode=n&logintoken=abc",
            "https://mesh.example.com/?gotonode=n&LOGIN=abc",
            "https://gw.example.com/#/client/abc?token=secret",
            "https://gw.example.com/?Password=x#/client/abc",
        ] {
            assert_eq!(
                check_open_url(raw).unwrap_err().code,
                "remote_desktop_console_url_has_credentials",
                "{raw}"
            );
        }
    }

    #[test]
    fn only_bounded_http_links_with_a_host_are_accepted() {
        for raw in [
            "",
            "ftp://gw.example.com/",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://",
            "not a url",
        ] {
            assert_eq!(code(raw, ConsoleProfile::Generic), "remote_desktop_console_url_invalid", "{raw}");
        }
        let long = format!("https://gw.example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(code(&long, ConsoleProfile::Generic), "remote_desktop_console_url_invalid");
        let v6 = parse("http://[fd00::5]:8080/", ConsoleProfile::Generic).unwrap();
        assert_eq!((v6.host.as_str(), v6.port, v6.https), ("fd00::5", 8080, false));
        let v4 = parse("http://192.168.1.9/", ConsoleProfile::Generic).unwrap();
        assert_eq!((v4.host.as_str(), v4.port), ("192.168.1.9", 80));
    }

    #[test]
    fn plain_http_is_for_lan_consoles_only() {
        let http = parse("http://console.lan/", ConsoleProfile::Generic).unwrap();
        assert!(require_transport(&http, EndpointClass::Private).is_ok());
        assert_eq!(
            require_transport(&http, EndpointClass::Public).unwrap_err().code,
            "remote_desktop_console_url_insecure"
        );
        let https = parse("https://console.example.com/", ConsoleProfile::Generic).unwrap();
        assert!(require_transport(&https, EndpointClass::Public).is_ok());
    }
}
