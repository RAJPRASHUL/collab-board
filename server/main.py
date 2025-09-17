import asyncio
import json
import logging
import os
import uuid
from collections import deque
from typing import Deque, Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# ---------------------------
# Configuration & Logging
# ---------------------------
# Environment-driven configuration with sensible defaults for development.
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5174,http://127.0.0.1:5174",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5174,http://127.0.0.1:5174,https://*.onrender.com",
    ).split(",")
    if origin.strip()
]
ALLOW_CREDENTIALS = True
ALLOW_METHODS = ["GET", "POST", "OPTIONS"]
ALLOW_HEADERS = ["Authorization", "Content-Type"]

# Security Headers
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: *; img-src 'self' data: blob:; worker-src 'self' blob:;",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "X-XSS-Protection": "1; mode=block"
}

# Resource limits and behavior
MAX_HISTORY_PER_ROOM = int(os.getenv("MAX_HISTORY_PER_ROOM", "500"))
MAX_ROOMS = int(os.getenv("MAX_ROOMS", "1000"))
BROADCAST_SEND_TIMEOUT = float(os.getenv("BROADCAST_SEND_TIMEOUT", "2.0"))
MAX_MESSAGE_BYTES = int(os.getenv("MAX_MESSAGE_BYTES", "65536"))  # 64 KB default
IDLE_TIMEOUT_SECONDS: Optional[float] = (
    float(os.getenv("IDLE_TIMEOUT_SECONDS")) if os.getenv("IDLE_TIMEOUT_SECONDS") else None
)
ECHO_SENDER_EVENTS = os.getenv("ECHO_SENDER_EVENTS", "true").lower() in {"1", "true", "yes"}

# Optional shared secret for basic authorization (query param token)
SHARED_SECRET = os.getenv("SHARED_SECRET")

# WebSocket close codes
WS_CLOSE_POLICY_VIOLATION = 1008
WS_CLOSE_MESSAGE_TOO_BIG = 1009
WS_CLOSE_TRY_AGAIN_LATER = 1013
WS_CLOSE_GOING_AWAY = 1001

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("whiteboard.server")

app = FastAPI()

# Add security headers middleware
@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    for header_name, header_value in SECURITY_HEADERS.items():
        response.headers[header_name] = header_value
    return response

# Enable CORS
# Note: Browsers disallow allow_credentials=True combined with allow_origins=["*"]
# so we provide an explicit allowlist from ALLOWED_ORIGINS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=ALLOW_CREDENTIALS,
    allow_methods=ALLOW_METHODS,
    allow_headers=ALLOW_HEADERS,
)


# --- Room & Connection Management ---
class RoomManager:
    """Manages rooms and WebSocket connections per room with concurrency controls."""

    def __init__(self):
        self.rooms: Dict[str, List[WebSocket]] = {}
        self.history: Dict[str, Deque[dict]] = {}
        self._locks: Dict[str, asyncio.Lock] = {}
        self._manager_lock = asyncio.Lock()

    def _get_room_lock(self, room_id: str) -> asyncio.Lock:
        # Lazily initialize a lock per room.
        if room_id not in self._locks:
            self._locks[room_id] = asyncio.Lock()
        return self._locks[room_id]

    async def ensure_room(self, room_id: str) -> None:
        # Ensure room structures exist, protected by manager lock to avoid races.
        async with self._manager_lock:
            if room_id not in self.rooms:
                if len(self.rooms) >= MAX_ROOMS:
                    raise RuntimeError("Max rooms limit reached")
                self.rooms[room_id] = []
                self.history[room_id] = deque(maxlen=MAX_HISTORY_PER_ROOM)
                self._locks[room_id] = asyncio.Lock()

    async def connect(self, websocket: WebSocket, room_id: str) -> None:
        # Accept and register the WebSocket in the room, then send history.
        await websocket.accept()
        room_lock = self._get_room_lock(room_id)
        async with room_lock:
            self.rooms.setdefault(room_id, [])
            self.history.setdefault(room_id, deque(maxlen=MAX_HISTORY_PER_ROOM))
            self.rooms[room_id].append(websocket)
            logger.info(f"[{room_id}] New connection. Total clients: {len(self.rooms[room_id])}")

            # Send history to new client
            history_payload = list(self.history[room_id])
            if history_payload:
                try:
                    await websocket.send_json({
                        "type": "history",
                        "payload": history_payload,
                    })
                except Exception as e:
                    logger.warning(f"[{room_id}] Error sending history: {e}")

    async def disconnect(self, websocket: WebSocket, room_id: str) -> None:
        room_lock = self._get_room_lock(room_id)
        async with room_lock:
            if room_id in self.rooms and websocket in self.rooms[room_id]:
                self.rooms[room_id].remove(websocket)
                logger.info(f"[{room_id}] Connection closed. Total clients: {len(self.rooms[room_id])}")

                # Attempt to close socket if still open
                try:
                    if websocket.client_state.name != "DISCONNECTED":
                        await websocket.close(code=WS_CLOSE_GOING_AWAY)
                except Exception:
                    pass

                # Cleanup empty room
                if not self.rooms[room_id]:
                    self.rooms.pop(room_id, None)
                    self.history.pop(room_id, None)
                    self._locks.pop(room_id, None)

    async def broadcast(
        self,
        message: dict,
        room_id: str,
        sender: Optional[WebSocket] = None,
        include_sender: bool = True,
    ) -> None:
        """Send a message to all clients in the room.

        Sends concurrently with a timeout and removes dead clients.
        """
        payload = json.dumps(message)
        recipients: List[WebSocket] = []

        room_lock = self._get_room_lock(room_id)
        async with room_lock:
            for ws in self.rooms.get(room_id, []):
                if include_sender:
                    recipients.append(ws)
                else:
                    if ws is not sender:
                        recipients.append(ws)

        tasks = []
        for ws in recipients:
            async def send_one(sock: WebSocket):
                try:
                    await asyncio.wait_for(sock.send_text(payload), timeout=BROADCAST_SEND_TIMEOUT)
                except Exception:
                    # mark as dead by raising again for outer handler
                    raise

            tasks.append(send_one(ws))

        if not tasks:
            return

        results = await asyncio.gather(*tasks, return_exceptions=True)
        dead_clients: List[WebSocket] = []
        for ws, res in zip(recipients, results):
            if isinstance(res, Exception):
                dead_clients.append(ws)

        if dead_clients:
            async with room_lock:
                for ws in dead_clients:
                    if room_id in self.rooms and ws in self.rooms[room_id]:
                        self.rooms[room_id].remove(ws)
                        try:
                            await ws.close(code=WS_CLOSE_GOING_AWAY)
                        except Exception:
                            pass
                if room_id in self.rooms and not self.rooms[room_id]:
                    self.rooms.pop(room_id, None)
                    self.history.pop(room_id, None)
                    self._locks.pop(room_id, None)


manager = RoomManager()


# --- Utility to generate new room IDs ---
def generate_room_id() -> str:
    return str(uuid.uuid4())


def _is_origin_allowed(origin: Optional[str]) -> bool:
    if not origin:
        return False
    # Exact match check; can be extended to regex or subdomain checks if needed.
    return origin in ALLOWED_ORIGINS


@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    logger.info(f"Incoming WS connection for room {room_id}")

    # Origin validation (CORS does not apply to WS handshakes)
    origin = websocket.headers.get("origin")
    if not _is_origin_allowed(origin):
        logger.warning(f"[{room_id}] Connection rejected due to invalid origin: {origin}")
        try:
            await websocket.close(code=WS_CLOSE_POLICY_VIOLATION)
        finally:
            return

    # Optional shared-secret token validation via query param `token`
    if SHARED_SECRET is not None:
        token = websocket.query_params.get("token")
        if token != SHARED_SECRET:
            logger.warning(f"[{room_id}] Connection rejected due to invalid token")
            try:
                await websocket.close(code=WS_CLOSE_POLICY_VIOLATION)
            finally:
                return

    # Ensure room exists and respect room caps
    try:
        await manager.ensure_room(room_id)
    except RuntimeError as e:
        logger.error(f"[{room_id}] {e}")
        try:
            await websocket.close(code=WS_CLOSE_TRY_AGAIN_LATER)
        finally:
            return

    # Accept and register connection
    await manager.connect(websocket, room_id)

    try:
        while True:
            # Receive message with optional idle timeout
            try:
                if IDLE_TIMEOUT_SECONDS is not None and IDLE_TIMEOUT_SECONDS > 0:
                    data = await asyncio.wait_for(websocket.receive_text(), timeout=IDLE_TIMEOUT_SECONDS)
                else:
                    data = await websocket.receive_text()
            except asyncio.TimeoutError:
                logger.info(f"[{room_id}] Idle timeout; closing connection")
                break

            # Enforce message size limit
            if len(data.encode("utf-8")) > MAX_MESSAGE_BYTES:
                logger.warning(f"[{room_id}] Message too large; closing connection")
                await websocket.close(code=WS_CLOSE_MESSAGE_TOO_BIG)
                break

            # Parse JSON safely
            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                logger.debug(f"[{room_id}] Ignoring non-JSON message")
                continue

            # Minimal schema validation
            msg_type = message.get("type")
            if not isinstance(msg_type, str):
                logger.debug(f"[{room_id}] Invalid message schema: missing or non-string 'type'")
                continue

            # *** ADD THIS DEBUG LINE HERE ***
            logger.info(f"[{room_id}] Received message type: {msg_type}, payload size: {len(str(message.get('payload', '')))}")

            # Handle message types
            if msg_type == "clear":
                # Clear history
                room_lock = manager._get_room_lock(room_id)
                async with room_lock:
                    if room_id in manager.history:
                        manager.history[room_id] = deque(maxlen=MAX_HISTORY_PER_ROOM)
                await manager.broadcast(message, room_id, include_sender=True)
                logger.info(f"[{room_id}] Canvas cleared")

            elif msg_type in ["undo", "redo"]:
                await manager.broadcast(message, room_id, include_sender=True)

            else:  # Normal drawing or other events
                # Persist to history (best-effort)
                room_lock = manager._get_room_lock(room_id)
                async with room_lock:
                    if room_id in manager.history:
                        manager.history[room_id].append(message)
                await manager.broadcast(
                    message,
                    room_id,
                    sender=websocket,
                    include_sender=ECHO_SENDER_EVENTS,
                )
                # *** ADD THIS DEBUG LINE HERE ***
                logger.info(f"[{room_id}] Broadcasted {msg_type} to room (include_sender: {ECHO_SENDER_EVENTS})")

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.exception(f"[{room_id}] Error: {e}")
    finally:
        await manager.disconnect(websocket, room_id)


@app.post("/rooms")
def create_room():
    """Create a new room (preferred API)."""
    room_id = generate_room_id()
    return {"room_id": room_id}


@app.get("/create-room")
def create_room_legacy():
    """Deprecated: Legacy endpoint retained for backward compatibility."""
    logger.warning("GET /create-room is deprecated. Use POST /rooms instead.")
    room_id = generate_room_id()
    return {"room_id": room_id}


@app.on_event("shutdown")
async def shutdown_event():
    """Attempt to gracefully close all active WebSocket connections on shutdown."""
    # Copy references to avoid mutation during iteration
    rooms_snapshot = list(manager.rooms.items())
    for room_id, sockets in rooms_snapshot:
        for ws in list(sockets):
            try:
                await ws.close(code=WS_CLOSE_GOING_AWAY)
            except Exception:
                pass
    logger.info("Server shutdown: all websockets signaled to close.")
