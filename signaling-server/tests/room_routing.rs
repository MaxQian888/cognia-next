//! End-to-end smoke test: boot the server on an ephemeral port, open two
//! WS clients, drive a subscribe→relay→leave dance, assert ordering.

use cognia_signaling_server::{
    proto::{ClientFrame, PeerRole, ServerFrame},
    serve_for_test,
};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    tungstenite::protocol::Message as TgMessage, MaybeTlsStream, WebSocketStream,
};

type WsClient = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(addr: std::net::SocketAddr) -> WsClient {
    connect_path(addr, "/v1/signaling").await
}

async fn connect_path(addr: std::net::SocketAddr, path: &str) -> WsClient {
    let url = format!("ws://{}{}", addr, path);
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws
}

async fn send(client: &mut WsClient, frame: ClientFrame) {
    let text = serde_json::to_string(&frame).unwrap();
    client.send(TgMessage::Text(text)).await.unwrap();
}

async fn recv(client: &mut WsClient) -> ServerFrame {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(2), client.next())
            .await
            .expect("ws recv timed out")
            .expect("ws recv stream closed")
            .expect("ws recv error");
        if let TgMessage::Text(text) = msg {
            return serde_json::from_str(text.as_str()).expect("server frame parse");
        }
        // Skip control frames (Ping/Pong) which the runtime may surface.
    }
}

#[tokio::test]
async fn two_peers_relay_via_room() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");

    // Desktop subscribes first.
    let mut desktop = connect(addr).await;
    send(
        &mut desktop,
        ClientFrame::Subscribe {
            rendezvous_id: "room-1".into(),
            role: PeerRole::Desktop,
            client_nonce: "nd".into(),
        },
    )
    .await;
    match recv(&mut desktop).await {
        ServerFrame::Subscribed { peers, .. } => assert!(peers.is_empty()),
        other => panic!("expected Subscribed, got {other:?}"),
    }

    // Mobile subscribes second; desktop must observe `peerJoined`.
    let mut mobile = connect(addr).await;
    send(
        &mut mobile,
        ClientFrame::Subscribe {
            rendezvous_id: "room-1".into(),
            role: PeerRole::Mobile,
            client_nonce: "nm".into(),
        },
    )
    .await;
    let mobile_subscribed = recv(&mut mobile).await;
    let desktop_notified = recv(&mut desktop).await;
    match mobile_subscribed {
        ServerFrame::Subscribed { peers, .. } => {
            assert_eq!(peers.len(), 1);
            assert_eq!(peers[0].role, PeerRole::Desktop);
        }
        other => panic!("expected Subscribed, got {other:?}"),
    }
    match desktop_notified {
        ServerFrame::PeerJoined { role, .. } => assert_eq!(role, PeerRole::Mobile),
        other => panic!("expected PeerJoined, got {other:?}"),
    }

    // Mobile relays. Desktop must observe the relay, mobile must not.
    send(
        &mut mobile,
        ClientFrame::Relay {
            rendezvous_id: "room-1".into(),
            payload: "opaque-base64==".into(),
        },
    )
    .await;
    match recv(&mut desktop).await {
        ServerFrame::Relay {
            from_role, payload, ..
        } => {
            assert_eq!(from_role, PeerRole::Mobile);
            assert_eq!(payload, "opaque-base64==");
        }
        other => panic!("expected Relay, got {other:?}"),
    }

    // Close mobile; desktop must observe peerLeft.
    drop(mobile);
    match recv(&mut desktop).await {
        ServerFrame::PeerLeft { role, .. } => assert_eq!(role, PeerRole::Mobile),
        other => panic!("expected PeerLeft, got {other:?}"),
    }
}

#[tokio::test]
async fn relay_to_unsubscribed_room_errors() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;

    send(
        &mut client,
        ClientFrame::Relay {
            rendezvous_id: "ghost".into(),
            payload: "x".into(),
        },
    )
    .await;
    match recv(&mut client).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "not_subscribed"),
        other => panic!("expected Error, got {other:?}"),
    }
}

#[tokio::test]
async fn ping_round_trips() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;
    send(&mut client, ClientFrame::Ping).await;
    match recv(&mut client).await {
        ServerFrame::Pong => {}
        other => panic!("expected Pong, got {other:?}"),
    }
}

#[tokio::test]
async fn malformed_frame_does_not_disconnect() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;
    client
        .send(TgMessage::Text("not-json".into()))
        .await
        .unwrap();
    match recv(&mut client).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "malformed_frame"),
        other => panic!("expected Error, got {other:?}"),
    }
    // The client is still usable.
    send(&mut client, ClientFrame::Ping).await;
    matches!(recv(&mut client).await, ServerFrame::Pong);
}

#[tokio::test]
async fn binary_frame_is_rejected_gracefully() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");
    let mut client = connect(addr).await;
    client.send(TgMessage::Binary(vec![1, 2, 3])).await.unwrap();
    match recv(&mut client).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "binary_not_supported"),
        other => panic!("expected Error, got {other:?}"),
    }
    // Binary frames are rejected without closing the socket.
    send(&mut client, ClientFrame::Ping).await;
    assert!(matches!(recv(&mut client).await, ServerFrame::Pong));
}

#[tokio::test]
async fn explicit_unsubscribe_announces_peer_left() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");

    let mut desktop = connect(addr).await;
    send(
        &mut desktop,
        ClientFrame::Subscribe {
            rendezvous_id: "u".into(),
            role: PeerRole::Desktop,
            client_nonce: "d".into(),
        },
    )
    .await;
    assert!(matches!(
        recv(&mut desktop).await,
        ServerFrame::Subscribed { .. }
    ));

    let mut mobile = connect(addr).await;
    send(
        &mut mobile,
        ClientFrame::Subscribe {
            rendezvous_id: "u".into(),
            role: PeerRole::Mobile,
            client_nonce: "m".into(),
        },
    )
    .await;
    assert!(matches!(
        recv(&mut mobile).await,
        ServerFrame::Subscribed { .. }
    ));
    assert!(matches!(
        recv(&mut desktop).await,
        ServerFrame::PeerJoined { .. }
    ));

    // Explicit unsubscribe — distinct from the socket-close path in
    // `two_peers_relay_via_room`.
    send(
        &mut mobile,
        ClientFrame::Unsubscribe {
            rendezvous_id: "u".into(),
        },
    )
    .await;
    match recv(&mut desktop).await {
        ServerFrame::PeerLeft { role, .. } => assert_eq!(role, PeerRole::Mobile),
        other => panic!("expected PeerLeft, got {other:?}"),
    }
}

#[tokio::test]
async fn one_socket_can_join_multiple_rooms() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");

    // A single socket subscribes to two rooms.
    let mut hub = connect(addr).await;
    for room in ["a", "b"] {
        send(
            &mut hub,
            ClientFrame::Subscribe {
                rendezvous_id: room.into(),
                role: PeerRole::Desktop,
                client_nonce: "h".into(),
            },
        )
        .await;
        assert!(matches!(
            recv(&mut hub).await,
            ServerFrame::Subscribed { .. }
        ));
    }

    // A peer in room "b" relays; the hub must receive it tagged room "b".
    let mut other = connect(addr).await;
    send(
        &mut other,
        ClientFrame::Subscribe {
            rendezvous_id: "b".into(),
            role: PeerRole::Mobile,
            client_nonce: "o".into(),
        },
    )
    .await;
    assert!(matches!(
        recv(&mut other).await,
        ServerFrame::Subscribed { .. }
    ));
    assert!(matches!(
        recv(&mut hub).await,
        ServerFrame::PeerJoined { .. }
    ));

    send(
        &mut other,
        ClientFrame::Relay {
            rendezvous_id: "b".into(),
            payload: "p".into(),
        },
    )
    .await;
    match recv(&mut hub).await {
        ServerFrame::Relay {
            rendezvous_id,
            payload,
            ..
        } => {
            assert_eq!(rendezvous_id, "b");
            assert_eq!(payload, "p");
        }
        other => panic!("expected Relay on room b, got {other:?}"),
    }
}

#[tokio::test]
async fn upgrade_rid_rejects_mismatched_frame_room() {
    let (addr, _handle) = serve_for_test().await.expect("server spawn");

    let mut desktop = connect_path(addr, "/v1/signaling?rid=bound").await;
    send(
        &mut desktop,
        ClientFrame::Subscribe {
            rendezvous_id: "bound".into(),
            role: PeerRole::Desktop,
            client_nonce: "d".into(),
        },
    )
    .await;
    assert!(matches!(
        recv(&mut desktop).await,
        ServerFrame::Subscribed { .. }
    ));

    let mut mismatch = connect_path(addr, "/v1/signaling?rid=bound").await;
    send(
        &mut mismatch,
        ClientFrame::Subscribe {
            rendezvous_id: "other".into(),
            role: PeerRole::Mobile,
            client_nonce: "m".into(),
        },
    )
    .await;
    match recv(&mut mismatch).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "room_mismatch"),
        other => panic!("expected room_mismatch, got {other:?}"),
    }

    send(
        &mut mismatch,
        ClientFrame::Relay {
            rendezvous_id: "other".into(),
            payload: "leak".into(),
        },
    )
    .await;
    match recv(&mut mismatch).await {
        ServerFrame::Error { code, .. } => assert_eq!(code, "room_mismatch"),
        other => panic!("expected room_mismatch relay error, got {other:?}"),
    }
}
