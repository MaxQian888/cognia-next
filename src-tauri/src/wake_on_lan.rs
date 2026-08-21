//! Wake a paired desktop that went to sleep before we could reach it.
//!
//! The connectivity ladder tries LAN, then tunnel, then the cached address, and
//! when all three fail it concludes the host is offline. For a sleeping desktop
//! that conclusion is wrong but self-fulfilling: nothing ever wakes it, so it
//! stays "offline" until a human touches the keyboard.
//!
//! A magic packet fixes exactly that case, and only that case — it needs the
//! host's MAC, a LAN path to it, and Wake-on-LAN enabled in its firmware. It is
//! therefore a *hint* the ladder issues before giving up, never a transport.
//!
//! This lives in Rust because a magic packet is a UDP broadcast and no WebView
//! can send one.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};

/// Ports Wake-on-LAN implementations listen on. The payload is identical; some
/// NICs only watch one of them, so a wake attempt sends to all.
const WOL_PORTS: [u16; 3] = [7, 9, 40000];
const MAC_BYTES: usize = 6;
const MAGIC_PREFIX: [u8; 6] = [0xff; 6];
const MAGIC_REPEATS: usize = 16;

/// Parse `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff`, or `aabbccddeeff`.
pub fn parse_mac(value: &str) -> Result<[u8; MAC_BYTES], String> {
    let cleaned: String = value
        .chars()
        .filter(|character| !matches!(character, ':' | '-' | '.' | ' '))
        .collect();
    if cleaned.len() != MAC_BYTES * 2 || !cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("not a MAC address: {value}"));
    }
    let mut mac = [0u8; MAC_BYTES];
    for (index, byte) in mac.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&cleaned[index * 2..index * 2 + 2], 16)
            .map_err(|error| format!("not a MAC address: {error}"))?;
    }
    Ok(mac)
}

/// Six `0xFF` bytes followed by the target MAC repeated sixteen times.
pub fn magic_packet(mac: [u8; MAC_BYTES]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(MAGIC_PREFIX.len() + MAC_BYTES * MAGIC_REPEATS);
    packet.extend_from_slice(&MAGIC_PREFIX);
    for _ in 0..MAGIC_REPEATS {
        packet.extend_from_slice(&mac);
    }
    packet
}

/// Send a magic packet for `mac`, broadcast on the local network.
///
/// `broadcast` defaults to the limited broadcast address. A caller that knows
/// the host's subnet should pass its directed broadcast (e.g. `192.168.1.255`)
/// instead — some routers drop `255.255.255.255` but forward a directed one.
pub fn wake(mac: &str, broadcast: Option<&str>) -> Result<(), String> {
    let parsed = parse_mac(mac)?;
    let target: Ipv4Addr = match broadcast {
        Some(value) => value
            .parse()
            .map_err(|_| format!("not a broadcast address: {value}"))?,
        None => Ipv4Addr::BROADCAST,
    };
    let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("wake-on-lan socket failed: {error}"))?;
    socket
        .set_broadcast(true)
        .map_err(|error| format!("wake-on-lan broadcast failed: {error}"))?;
    let packet = magic_packet(parsed);
    let mut delivered = 0usize;
    let mut last_error = String::new();
    for port in WOL_PORTS {
        match socket.send_to(&packet, SocketAddr::from(SocketAddrV4::new(target, port))) {
            Ok(_) => delivered += 1,
            Err(error) => last_error = error.to_string(),
        }
    }
    if delivered == 0 {
        return Err(format!("wake-on-lan send failed: {last_error}"));
    }
    Ok(())
}

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

    #[test]
    fn parses_every_common_mac_notation() {
        let expected = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
        assert_eq!(parse_mac("AA:BB:CC:DD:EE:FF").unwrap(), expected);
        assert_eq!(parse_mac("aa-bb-cc-dd-ee-ff").unwrap(), expected);
        assert_eq!(parse_mac("aabbccddeeff").unwrap(), expected);
        assert_eq!(parse_mac("aabb.ccdd.eeff").unwrap(), expected);
    }

    #[test]
    fn rejects_anything_that_is_not_a_mac() {
        // A hostname or an IP reaching this function means the pairing record
        // stored the wrong field; broadcasting it as a MAC would be silent.
        for bad in [
            "",
            "not-a-mac",
            "aa:bb:cc:dd:ee",
            "aa:bb:cc:dd:ee:ff:00",
            "zz:bb:cc:dd:ee:ff",
            "192.168.1.4",
        ] {
            assert!(parse_mac(bad).is_err(), "expected {bad} to be rejected");
        }
    }

    #[test]
    fn magic_packet_has_the_wire_shape_nics_match_on() {
        let packet = magic_packet([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
        assert_eq!(packet.len(), 6 + 6 * 16);
        assert_eq!(&packet[..6], &[0xff; 6]);
        for repeat in 0..16 {
            let start = 6 + repeat * 6;
            assert_eq!(
                &packet[start..start + 6],
                &[0x01, 0x02, 0x03, 0x04, 0x05, 0x06]
            );
        }
    }

    #[test]
    fn rejects_a_broadcast_address_that_is_not_an_address() {
        assert!(wake("aa:bb:cc:dd:ee:ff", Some("not-an-ip")).is_err());
    }

    #[test]
    fn sends_to_every_wake_on_lan_port() {
        // Some NICs only listen on one of the three; a wake that picked one
        // would work on some hardware and silently not on the rest.
        assert_eq!(WOL_PORTS.len(), 3);
        assert!(WOL_PORTS.contains(&9));
        assert!(wake("aa:bb:cc:dd:ee:ff", Some("127.0.0.1")).is_ok());
    }
}
