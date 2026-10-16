"""Authenticate the pinned upstream ASGI application without changing its API."""

import ctypes
import json
import os
import secrets
import socket
import threading


class TokenAuth:
    def __init__(self, app, token):
        self.app = app
        self.token = token.encode("ascii")

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = scope.get("headers", [])
        supplied = [value for key, value in headers if key.lower() == b"x-cognia-sandbox-token"]
        # Native clients supply a private header. Browser-origin requests are
        # rejected even if they somehow obtain credentials from elsewhere.
        valid = len(supplied) == 1 and secrets.compare_digest(supplied[0], self.token)
        valid = valid and not any(key.lower() == b"origin" for key, _ in headers)
        if valid:
            if scope["type"] == "http" and scope.get("path") == "/cognia/health" and scope.get("method") == "GET":
                body = json.dumps({"protocol": "computer-server-0.3.46", "recipeRevision": "4",
                                   "serverVersion": "0.3.46"}).encode("utf-8")
                await send({"type": "http.response.start", "status": 200,
                            "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
                return await send({"type": "http.response.body", "body": body})
            return await self.app(scope, receive, send)
        if scope["type"] == "http":
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"Unauthorized"})
        elif "websocket.http.response" in scope.get("extensions", {}):
            await send({"type": "websocket.http.response.start", "status": 401,
                        "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "websocket.http.response.body", "body": b"Unauthorized"})
        else:
            # An ASGI close before accept produces HTTP 403 under Uvicorn.
            await send({"type": "websocket.close", "code": 1008})


def prepare_managed_listener(fd=3):
    """Accept only the guard's pre-opened Unix stream listener, never TCP."""
    try:
        duplicate = os.dup(fd)
        try:
            listener = socket.socket(fileno=duplicate)
        except OSError:
            os.close(duplicate)
            raise
        with listener:
            if (listener.family != socket.AF_UNIX
                    or listener.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM
                    or listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1):
                raise RuntimeError("Invalid managed desktop listener")
        # The original process keeps this descriptor; every exec'd desktop
        # child must lose it, including before the server imports upstream code.
        os.set_inheritable(fd, False)
    except OSError:
        raise RuntimeError("Managed desktop listener is unavailable") from None
    return fd


def serve(token, should_stop, listener_fd=None):
    # Neither guest applications nor same-uid children may inspect the server
    # credential in /proc/<pid>/environ or memory.
    if ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
        raise RuntimeError("Could not protect desktop server credentials")
    if len(token) != 64 or any(character not in "0123456789abcdef" for character in token):
        raise RuntimeError("Missing or invalid private desktop server credential")
    from computer_server.main import app
    import uvicorn

    if listener_fd is None:
        transport = {"host": "0.0.0.0", "port": 8000}
    else:
        transport = {"fd": prepare_managed_listener(listener_fd)}
    server = uvicorn.Server(uvicorn.Config(TokenAuth(app, token), log_level="info", **transport))
    finished = threading.Event()

    def monitor():
        while not finished.wait(0.2):
            if should_stop():
                server.should_exit = True
                return

    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    try:
        server.run()
    finally:
        finished.set()
        watcher.join(timeout=1)


if __name__ == "__main__":
    # Production imports serve() into the already protected startup process.
    # It never places this credential in a newly exec'd child's environment.
    serve(os.environ.pop("COGNIA_CUA_AUTH_TOKEN", ""), lambda: False)
