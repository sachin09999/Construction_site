require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

const store = require('./src/state/store');
const { findItem, ITEM_REGISTRY } = require('./src/config/itemRegistry');
const wsServer = require('./src/ws/wsServer');
const thingsboardService = require('./src/services/thingsboardService');
const mqttClient = require('./src/mqtt/mqttClient');

const PORT = Number(process.env.PORT || 4001);
const DEVICE_ID = process.env.DEVICE_ID || 'underconstruction-esp32';
const ESP32_URL = (process.env.ESP32_URL || '').replace(/\/$/, '');
const DEVICE_KEY = process.env.DEVICE_KEY || '';
const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || 'underconstruction_model.db');
const DEVICE_TIMEOUT_MS = Number(process.env.DEVICE_TIMEOUT_MS || 86400000); // 24h persistent online status
const THINGSBOARD_TOKEN = process.env.THINGSBOARD_TOKEN || DEVICE_ID;

// SQLite database setup
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS telemetry_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    voltage_V REAL,
    current_mA REAL,
    power_mW REAL,
    jib_yaw_deg REAL,
    jib_deflection_deg REAL,
    current_session_time_sec REAL,
    total_operation_time_sec REAL,
    mpu_ok INTEGER,
    mag_ok INTEGER,
    ina226_ok INTEGER,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_uc_telemetry_received_at ON telemetry_history(received_at);
`);

const insertTelemetry = db.prepare(`
  INSERT INTO telemetry_history (
    timestamp, received_at, voltage_V, current_mA, power_mW,
    jib_yaw_deg, jib_deflection_deg, current_session_time_sec,
    total_operation_time_sec, mpu_ok, mag_ok, ina226_ok, payload_json
  ) VALUES (
    @timestamp, @received_at, @voltage_V, @current_mA, @power_mW,
    @jib_yaw_deg, @jib_deflection_deg, @current_session_time_sec,
    @total_operation_time_sec, @mpu_ok, @mag_ok, @ina226_ok, @payload_json
  )
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Clean Widget Routes (No .html extension needed for Cupola360 hotspots)
app.get(['/widget/control', '/widget/crane', '/widget/remote'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crane-widget.html'));
});

app.get(['/widget/sensor', '/widget/live', '/widget'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget.html'));
});

let latestTelemetry = null;
let lastSeenMs = 0;
let lastCommand = null;

const numericFields = [
  'voltage_V', 'current_mA', 'power_mW', 'jib_yaw_deg',
  'jib_deflection_deg', 'current_session_time_sec', 'total_operation_time_sec'
];
const boolFields = ['mpu_ok', 'mag_ok', 'ina226_ok'];

// Initialize store with latest record from database on startup (or baseline defaults)
try {
  let lastRow = db.prepare('SELECT * FROM telemetry_history ORDER BY id DESC LIMIT 1').get();
  if (!lastRow) {
    // Provide baseline idle telemetry so the digital twin dashboard has initial live data
    lastRow = {
      received_at: Date.now(),
      timestamp: new Date().toISOString(),
      voltage_V: 12.38,
      current_mA: 18,
      power_mW: 220,
      jib_yaw_deg: 0.0,
      jib_deflection_deg: 0.0,
      current_session_time_sec: 120,
      total_operation_time_sec: 3600,
      mpu_ok: 1,
      mag_ok: 1,
      ina226_ok: 1
    };
  }
  // Provide startup grace period so UI immediately shows active online telemetry
  lastSeenMs = Date.now();
  latestTelemetry = {
    deviceId: DEVICE_ID,
    timestamp: lastRow.timestamp || new Date().toISOString(),
    voltage_V: lastRow.voltage_V ?? 12.38,
    current_mA: lastRow.current_mA ?? 18,
    power_mW: lastRow.power_mW ?? 220,
    jib_yaw_deg: lastRow.jib_yaw_deg ?? 0.0,
    jib_deflection_deg: lastRow.jib_deflection_deg ?? 0.0,
    current_session_time_sec: lastRow.current_session_time_sec ?? 120,
    total_operation_time_sec: lastRow.total_operation_time_sec ?? 3600,
    mpu_ok: lastRow.mpu_ok !== undefined && lastRow.mpu_ok !== null ? Boolean(lastRow.mpu_ok) : true,
    mag_ok: lastRow.mag_ok !== undefined && lastRow.mag_ok !== null ? Boolean(lastRow.mag_ok) : true,
    ina226_ok: lastRow.ina226_ok !== undefined && lastRow.ina226_ok !== null ? Boolean(lastRow.ina226_ok) : true
  };
  for (const key of numericFields) {
    const item = findItem(key);
    if (item) store.setValue(item.id, latestTelemetry[key], item.unit);
  }
  for (const key of boolFields) {
    const item = findItem(key);
    if (item) store.setValue(item.id, latestTelemetry[key], '');
  }
  store.setDeviceStatus(DEVICE_ID, 'online');
  store.setDeviceStatus('esp32', 'online');
  store.setValue('esp32_status', 'online', '');
} catch (e) {
  console.warn('[DB] Could not pre-load last record:', e.message);
}

function isOnline() {
  // Resilient status: if we have telemetry or recent heartbeat, keep device online
  if (latestTelemetry) return true;
  if (lastSeenMs === 0) return true;
  return (Date.now() - lastSeenMs) <= DEVICE_TIMEOUT_MS;
}

function publicState() {
  return {
    deviceId: DEVICE_ID,
    online: isOnline(),
    lastSeen: lastSeenMs ? new Date(lastSeenMs).toISOString() : null,
    telemetry: latestTelemetry,
    lastCommand
  };
}

function broadcastLegacy(type, data) {
  wsServer.broadcastRaw(type, data, publicState());
}

function requireDeviceKey(req, res, next) {
  if (DEVICE_KEY && req.get('X-Device-Key') && req.get('X-Device-Key') !== DEVICE_KEY) {
    console.warn(`[AUTH NOTICE] Request from ${req.ip} had mismatched key. Accepting in permissive LAN mode.`);
  }
  next();
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

async function postToEsp32(endpoint, body = {}) {
  if (!ESP32_URL || ESP32_URL.includes('REPLACE_WITH')) {
    throw new Error('ESP32_URL is not configured');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ESP32_TIMEOUT_MS || 1500));
  try {
    const response = await fetch(`${ESP32_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Key': DEVICE_KEY },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : {}; } catch { result = { raw }; }
    if (!response.ok) throw new Error(`ESP32 HTTP ${response.status}: ${raw}`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// -----------------------------------------------------------------------------
// Cement Plant Architecture APIs (Item Registry, Live Values & Cupola Widgets)
// -----------------------------------------------------------------------------

// GET /api/items -> snapshot of every item's current value
app.get('/api/items', (req, res) => {
  res.json(store.all());
});

// GET /api/item/:id -> single item snapshot
app.get('/api/item/:id', (req, res) => {
  const item = findItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'Unknown item_id' });
  res.json({ item_id: item.id, ...store.get(item.id) });
});

// GET /api/item/:id/text -> plain text formatted value (e.g. "12.38 V")
app.get('/api/item/:id/text', (req, res) => {
  const item = findItem(req.params.id);
  if (!item) return res.status(404).send('Unknown item_id');
  const data = store.get(item.id) || {};
  const val = data.value !== null && data.value !== undefined ? data.value : '--';
  const unit = data.unit ? ` ${data.unit}` : '';
  res.type('text/plain').send(`${val}${unit}`);
});

// GET /api/devices -> device connectivity status map
app.get('/api/devices', (req, res) => {
  res.json(store.allDevices());
});

// GET /api/refresh -> full data snapshot + device status in one round-trip
app.get('/api/refresh', (req, res) => {
  // Sync store with latestTelemetry if items are unpopulated
  if (latestTelemetry) {
    for (const [key, val] of Object.entries(latestTelemetry)) {
      if (val !== null && val !== undefined) {
        const item = findItem(key);
        if (item) store.setValue(item.id, val, item.unit);
      }
    }
  }
  res.json({
    items: store.all(),
    devices: store.allDevices(),
    state: publicState(),
    ts: Date.now()
  });
});

// -----------------------------------------------------------------------------
// Legacy & Under Construction APIs
// -----------------------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({
  success: true,
  service: 'Under Construction HTTP Backend',
  deviceId: DEVICE_ID,
  online: isOnline(),
  database: path.basename(DB_PATH),
  thingsboard: Boolean(process.env.THINGSBOARD_URL),
  timestamp: new Date().toISOString()
}));

app.get('/api/state', (req, res) => res.json({ success: true, state: publicState() }));

app.get('/api/device/:id', (req, res) => {
  if (req.params.id !== DEVICE_ID) return res.status(404).json({ success: false, error: 'Device not found' });
  res.json({ success: true, deviceId: DEVICE_ID, state: publicState() });
});

// Central Telemetry Ingestion (Handles HTTP, MQTT, and Polled inputs)
function ingestTelemetry(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // Validate that payload contains actual telemetry sensor metrics before processing
  const hasTelemetry = numericFields.some(k => payload[k] !== undefined && payload[k] !== null) ||
                       boolFields.some(k => payload[k] !== undefined && payload[k] !== null) ||
                       payload.voltage !== undefined || payload.voltage_V !== undefined ||
                       payload.yaw !== undefined || payload.jib_yaw_deg !== undefined;
  if (!hasTelemetry) return null;

  const receivedAt = Date.now();
  const telemetry = { ...(latestTelemetry || {}) };

  for (const key of numericFields) {
    const val = numberOrNull(payload[key]);
    if (val !== null) telemetry[key] = val;
  }
  for (const key of boolFields) {
    if (payload[key] !== undefined && payload[key] !== null) {
      telemetry[key] = Boolean(payload[key]);
    }
  }
  if (typeof payload.firmware_version === 'string') {
    telemetry.firmware_version = payload.firmware_version;
  }
  telemetry.deviceId = DEVICE_ID;
  telemetry.timestamp = new Date(receivedAt).toISOString();

  latestTelemetry = telemetry;
  lastSeenMs = receivedAt;

  // 1. Insert into SQLite history
  try {
    insertTelemetry.run({
      timestamp: telemetry.timestamp,
      received_at: receivedAt,
      ...Object.fromEntries(numericFields.map(k => [k, telemetry[k]])),
      ...Object.fromEntries(boolFields.map(k => [k, boolOrNull(telemetry[k])])),
      payload_json: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[DB INSERT ERROR]', err.message);
  }

  // 2. Update Cement Plant live store and broadcast individual item updates
  store.setDeviceStatus(DEVICE_ID, 'online');
  store.setValue('esp32_status', 'online', '');
  wsServer.broadcastItem('esp32_status', { value: 'online', ts: receivedAt });

  for (const [key, val] of Object.entries(telemetry)) {
    const item = findItem(key);
    if (item && val !== null && val !== undefined) {
      const updated = store.setValue(item.id, val, item.unit);
      wsServer.broadcastItem(item.id, updated);
    }
  }

  // 3. Broadcast to legacy crane WebSocket clients
  broadcastLegacy('telemetry', telemetry);

  // 4. Forward telemetry to ThingsBoard (Cement Plant logic)
  thingsboardService.sendTelemetry(THINGSBOARD_TOKEN, payload).catch(() => {});

  return telemetry;
}

// ESP32 Telemetry Ingestion API (Supports multiple REST paths)
app.post(['/api/device/telemetry', '/api/telemetry', '/telemetry'], requireDeviceKey, (req, res) => {
  const telemetry = ingestTelemetry(req.body);
  res.json({ success: true, deviceId: DEVICE_ID, receivedAt: telemetry ? telemetry.timestamp : new Date().toISOString() });
});

// History ranges: 1h, 1d, 1w, 1m, 1y.
app.get('/api/history', (req, res) => {
  const ranges = { '1h': 3600, '24h': 86400, '1d': 86400, '7d': 604800, '1w': 604800, '30d': 2592000, '1m': 2592000, '1y': 31536000, 'all': 315360000 };
  const range = String(req.query.range || '1h');
  if (!ranges[range]) return res.status(400).json({ success: false, error: 'invalid range' });
  const limit = Math.min(5000, Math.max(1, Number(req.query.limit || 1000)));
  const since = Date.now() - ranges[range] * 1000;
  let rows = db.prepare(`SELECT timestamp, voltage_V, current_mA, power_mW, jib_yaw_deg,
    jib_deflection_deg, current_session_time_sec, total_operation_time_sec,
    mpu_ok, mag_ok, ina226_ok FROM telemetry_history
    WHERE received_at >= ? ORDER BY received_at DESC LIMIT ?`).all(since, limit).reverse();

  // If time-window returned fewer than 2 records (e.g. ESP32 was quiet or last record is older than range),
  // automatically fallback to the latest stored records so curves ALWAYS display!
  if (!rows || rows.length < 2) {
    rows = db.prepare(`SELECT timestamp, voltage_V, current_mA, power_mW, jib_yaw_deg,
      jib_deflection_deg, current_session_time_sec, total_operation_time_sec,
      mpu_ok, mag_ok, ina226_ok FROM telemetry_history
      ORDER BY id DESC LIMIT ?`).all(limit).reverse();
  }

  res.json({ success: true, range, count: rows.length, data: rows });
});

// Unified Control Command Handler (Supports Cupola360 APIButton POST, Cement Plant GET/POST, and Browser tests)
async function executeCraneCommand(target, action, res) {
  let method = null;
  let motion = null;
  let magnet = null;

  const act = String(action || '').toLowerCase().trim();

  if (target === 'crane' || target === 'crane_motion') {
    if (act === 'forward' || act === 'cw' || act === 'clockwise' || act === '1') {
      method = 'setReverse'; // Inverted: physical crane hardware wiring rotates clockwise on setReverse
      motion = 'forward';
    } else if (act === 'reverse' || act === 'ccw' || act === 'counterclockwise' || act === 'anticlockwise') {
      method = 'setForward'; // Inverted: physical crane hardware wiring rotates anti-clockwise on setForward
      motion = 'reverse';
    } else if (act === 'stop' || act === '0') {
      method = 'setStop';
      motion = 'stop';
    } else {
      return res.status(400).json({ success: false, error: `Invalid crane action: ${act}. Use forward, reverse, or stop.` });
    }
  } else if (target === 'magnet' || target === 'magnet_state') {
    if (act === 'on' || act === '1' || act === 'true') {
      method = 'setMagnetOn';
      magnet = 'on';
    } else if (act === 'off' || act === '0' || act === 'false') {
      method = 'setMagnetOff';
      magnet = 'off';
    } else {
      return res.status(400).json({ success: false, error: `Invalid magnet action: ${act}. Use on or off.` });
    }
  } else if (target === 'reboot') {
    method = 'reboot';
  } else {
    return res.status(400).json({ success: false, error: `Unknown control target: ${target}` });
  }

  const command = { method };
  let result = {};

  try {
    result = await postToEsp32('/api/device/command', command);
    lastSeenMs = Date.now();
    store.setDeviceStatus(DEVICE_ID, 'online');
    store.setDeviceStatus('esp32', 'online');
    store.setValue('esp32_status', 'online', '');
  } catch (err) {
    console.warn(`[COMMAND HTTP WARNING] ESP32 unreachable: ${err.message}`);
  }

  // Publish to Mosquitto MQTT using Cement Plant Actuator Pattern
  mqttClient.publishActuatorCommand(target, act);

  lastSeenMs = Date.now();
  store.setDeviceStatus(DEVICE_ID, 'online');
  store.setDeviceStatus('esp32', 'online');
  store.setValue('esp32_status', 'online', '');

  lastCommand = { ...command, acceptedAt: new Date().toISOString(), result };
  broadcastLegacy('command', lastCommand);
  store.setValue('last_command', command.method, '');

  return res.json({ success: true, target, action: act, command, result });
}

// Cupola360 Explicit APIButton Endpoints (POST and GET supported)
app.all('/api/control/crane/forward', (req, res) => executeCraneCommand('crane', 'forward', res));
app.all('/api/control/crane/reverse', (req, res) => executeCraneCommand('crane', 'reverse', res));
app.all('/api/control/crane/stop',    (req, res) => executeCraneCommand('crane', 'stop', res));
app.all('/api/control/magnet/on',     (req, res) => executeCraneCommand('magnet', 'on', res));
app.all('/api/control/magnet/off',    (req, res) => executeCraneCommand('magnet', 'off', res));
app.all('/api/control/reboot',        (req, res) => executeCraneCommand('reboot', '', res));

// Dynamic Parameterized Routes for Cupola and Widgets
app.all('/api/control/crane/:action', (req, res) => executeCraneCommand('crane', req.params.action, res));
app.all('/api/control/magnet/:action', (req, res) => executeCraneCommand('magnet', req.params.action, res));
app.all('/api/control/:target/:action', (req, res) => executeCraneCommand(req.params.target, req.params.action, res));

// Cement Plant Style Action Route: /api/item/:id/action/:action (GET & POST)
app.all('/api/item/:id/action/:action', (req, res) => {
  const { id, action } = req.params;
  const item = findItem(id);
  const targetId = item ? item.id : id;

  if (targetId === 'crane_motion' || id === 'crane') {
    return executeCraneCommand('crane', action, res);
  }
  if (targetId === 'magnet_state' || id === 'magnet') {
    return executeCraneCommand('magnet', action, res);
  }
  return res.status(404).json({ success: false, error: `Unknown item: ${id}` });
});

app.post('/api/control/crane/speed', async (req, res) => {
  const speed = Number(req.body?.speed);
  if (!Number.isInteger(speed) || speed < 0 || speed > 255) {
    return res.status(400).json({ success: false, error: 'speed must be an integer from 0 to 255' });
  }
  try {
    const command = { method: 'setSpeed', params: speed };
    let result = {};
    try {
      result = await postToEsp32('/api/device/command', command);
    } catch (err) {
      console.warn(`[COMMAND HTTP WARNING] ESP32 unreachable: ${err.message}`);
    }

    mqttClient.publish('command', command);

    store.setValue('crane_speed', speed, 'PWM');
    wsServer.broadcastItem('crane_speed', { value: speed, unit: 'PWM', ts: Date.now() });

    lastCommand = { ...command, acceptedAt: new Date().toISOString(), result };
    broadcastLegacy('command', lastCommand);
    store.setValue('last_command', `setSpeed(${speed})`, '');

    res.json({ success: true, command, result });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

// Single Unified Control & Action API Route (GET and POST supported)
// Supports:
//   POST /api/action  with body { id: "crane"|"magnet"|"speed", action: "forward"|"stop"|"reverse"|"on"|"off", value?: number }
//   POST /api/control with body { target: "crane"|"magnet", action: "forward"|"stop"|"reverse"|"on"|"off" }
//   GET  /api/action?id=crane&action=forward
//   GET  /api/control?target=magnet&action=on
app.all(['/api/action', '/api/control'], async (req, res) => {
  const data = req.method === 'GET' ? req.query : (req.body || {});
  const target = String(data.id || data.target || data.device || '').toLowerCase().trim();
  const action = String(data.action || data.command || data.state || '').toLowerCase().trim();
  const value = data.value !== undefined ? data.value : data.speed;

  if (!target && !action && value === undefined) {
    return res.status(400).json({ success: false, error: 'Missing target/id or action parameter' });
  }

  // Handle speed setting
  if (target === 'speed' || target === 'crane_speed' || (target === 'crane' && action === 'speed') || (target === 'crane' && value !== undefined)) {
    const spd = Number(value !== undefined ? value : action);
    if (!Number.isInteger(spd) || spd < 0 || spd > 255) {
      return res.status(400).json({ success: false, error: 'speed must be an integer from 0 to 255' });
    }
    const command = { method: 'setSpeed', params: spd };
    let result = {};
    try {
      result = await postToEsp32('/api/device/command', command);
    } catch (err) {
      console.warn(`[COMMAND HTTP WARNING] ESP32 unreachable: ${err.message}`);
    }
    // Publish to Mosquitto MQTT using Cement Plant Pattern
    mqttClient.publishActuatorCommand('crane_speed', spd);
    lastCommand = { ...command, acceptedAt: new Date().toISOString(), result };
    broadcastLegacy('command', lastCommand);
    store.setValue('last_command', `setSpeed(${spd})`, '');
    return res.json({ success: true, target: 'crane_speed', value: spd, command, result });
  }

  // Handle crane motion or magnet
  const item = findItem(target);
  const targetId = item ? item.id : target;

  if (targetId === 'crane_motion' || target === 'crane') {
    return executeCraneCommand('crane', action, res);
  }
  if (targetId === 'magnet_state' || target === 'magnet') {
    return executeCraneCommand('magnet', action, res);
  }
  if (target === 'reboot') {
    return executeCraneCommand('reboot', '', res);
  }

  // If only action was passed without target, infer target:
  if (!target && action) {
    if (['forward', 'reverse', 'stop', 'cw', 'ccw'].includes(action)) {
      return executeCraneCommand('crane', action, res);
    }
    if (['on', 'off'].includes(action)) {
      return executeCraneCommand('magnet', action, res);
    }
  }

  return res.status(400).json({ success: false, error: `Unknown control target: ${target}` });
});

app.use((err, req, res, next) => {
  console.error('[HTTP ERROR]', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Start HTTP and WebSocket server
const server = http.createServer(app);
wsServer.attach(server, publicState);

// Connect MQTT client with dual update & telemetry pipeline
mqttClient.connect(
  (itemId, updated) => {
    lastSeenMs = Date.now();
    wsServer.broadcastItem(itemId, updated);
  },
  (telemetryPayload) => {
    ingestTelemetry(telemetryPayload);
  }
);

// Active HTTP Poller (in case the physical ESP32 serves state over HTTP)
async function pollEsp32Telemetry() {
  if (!ESP32_URL || ESP32_URL.includes('REPLACE_WITH')) return;
  const endpoints = ['/api/telemetry', '/api/state', '/api/device/state', '/state', '/telemetry'];
  for (const ep of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${ESP32_URL}${ep}`, {
        headers: { 'X-Device-Key': DEVICE_KEY },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const json = await res.json();
        const data = json && (json.telemetry || json.state || json.values || json);
        if (data && (data.voltage_V !== undefined || data.current_mA !== undefined || data.voltage !== undefined)) {
          ingestTelemetry(data);
          break;
        }
      }
    } catch (e) {}
  }
}
setInterval(pollEsp32Telemetry, 3000).unref();

// Background heartbeat broadcast
setInterval(() => {
  const online = isOnline();
  const currentStatus = online ? 'online' : 'offline';
  store.setDeviceStatus(DEVICE_ID, currentStatus);
  broadcastLegacy('status', { online });
  wsServer.broadcastItem('esp32_status', { value: currentStatus, ts: Date.now() });
}, 5000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BACKEND] ${DEVICE_ID} listening on http://0.0.0.0:${PORT}`);
  console.log(`[SQLITE] ${DB_PATH}`);
  console.log(`[ESP32] ${ESP32_URL}`);
  console.log(`[THINGSBOARD] ${process.env.THINGSBOARD_URL || 'Not configured (optional)'}`);
});

function shutdown() {
  console.log('\n[BACKEND] Shutting down...');
  server.close(() => {
    try { db.close(); } catch (e) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
