# Under Construction Model — HTTP Backend

Dedicated Node.js backend for the miniature crane. It uses the Factory Model HTTP architecture: Express REST API, SQLite history, and WebSocket live updates. It has its own database (`underconstruction_model.db`) and device identity; it does not connect to MQTT or ThingsBoard.

## Requirements
- Node.js 22 or newer (the pinned `better-sqlite3` major version requires Node 22+).
- The Under Construction Mini PC and ESP32 must be reachable on the same LAN.

## Install
1. Copy this folder to the Under Construction Mini PC.
2. Copy `.env.example` to `.env`.
3. Set `ESP32_URL` to the crane ESP32's actual static IP and set a unique `DEVICE_KEY`.
4. Use the same key in the ESP32 firmware. Keep `.env` private.
5. In this folder run:
   ```bash
   npm install
   npm start
   ```
6. Check `http://MINI_PC_IP:4001/api/health`.

## API
- `GET /api/health` — backend and device status
- `GET /api/state` — latest live state
- `GET /api/device/underconstruction-esp32` — device snapshot
- `POST /api/device/telemetry` — ESP32 telemetry; requires `X-Device-Key`
- `GET /api/history?range=1h|1d|1w|1m|1y` — SQLite history
- `WS /ws` — live telemetry and status messages
- `POST /api/control/crane/forward`
- `POST /api/control/crane/reverse`
- `POST /api/control/crane/stop`
- `POST /api/control/magnet/on`
- `POST /api/control/magnet/off`
- `POST /api/control/crane/speed` with JSON `{ "speed": 0..255 }`
- `POST /api/control/reboot`

## ESP32 HTTP contract required
The backend forwards control requests to the ESP32 at `POST /api/device/command`, with JSON such as:
```json
{ "method": "setForward" }
{ "method": "setSpeed", "params": 160 }
```
The ESP32 must validate `X-Device-Key`, dispatch the existing crane operations (`setForward`, `setReverse`, `setStop`, `setMagnetOn`, `setMagnetOff`, `setSpeed`, `reboot`), and return a JSON success response. It must POST its existing telemetry fields to the backend's `/api/device/telemetry` every ~2 seconds with the same `X-Device-Key` header.

**Important:** this backend is the Mini PC side only. The currently supplied Crane firmware is MQTT-based and does not yet implement this HTTP telemetry sender / `/api/device/command` receiver. Dashboard commands will not physically operate the crane until the firmware is migrated to this HTTP contract. Existing sensor and actuator logic should be retained while replacing MQTT transport.
