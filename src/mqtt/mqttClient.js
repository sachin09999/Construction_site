// MQTT Client for Crane Digital Twin (Architecture matching Cement Plant model)
// -----------------------------------------------------------------------------
const mqtt = require("mqtt");
const store = require("../state/store");
const { findItem } = require("../config/itemRegistry");

let client = null;
let onUpdateCallback = null;
let onTelemetryCallback = null;

const PREFIX = process.env.MQTT_PREFIX || "plant/underconstruction";
const MQTT_HOST = process.env.MQTT_HOST || "host.docker.internal";
const MQTT_PORT = process.env.MQTT_PORT || "1883";

// Standard Cement Plant Topic Builders
function topicCommand()         { return `${PREFIX}/command`; }
function topicValues()          { return `${PREFIX}/values`; }
function topicStatus()          { return `${PREFIX}/status`; }
function topicActuatorCommand() { return `${PREFIX}/actuator/command`; }
function topicActuatorState()   { return `${PREFIX}/actuator/state`; }

function connect(onUpdate, onTelemetry) {
  onUpdateCallback = onUpdate;
  onTelemetryCallback = onTelemetry;
  const url = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
  const options = {
    reconnectPeriod: 4000,
    connectTimeout: 4000,
    keepalive: 60
  };
  if (process.env.MQTT_USER) {
    options.username = process.env.MQTT_USER;
    options.password = process.env.MQTT_PASSWORD;
  }

  console.log(`[MQTT] Connecting to Mosquitto broker at ${url}...`);
  try {
    client = mqtt.connect(url, options);

    client.on("connect", () => {
      console.log(`[MQTT] Connected to Mosquitto broker at ${url} (Prefix: ${PREFIX})`);
      client.subscribe("#"); // Wildcard subscription to capture all crane telemetry topics
    });

    client.on("reconnect", () => console.log("[MQTT] Reconnecting to broker..."));
    client.on("error", (err) => {
      console.warn(`[MQTT] Broker notice (${url}): ${err.message}`);
    });

    client.on("message", (topic, payloadBuf) => {
      let payload;
      try {
        payload = JSON.parse(payloadBuf.toString());
      } catch (e) {
        return;
      }
      handleIncoming(topic, payload);
    });
  } catch (err) {
    console.warn(`[MQTT] Could not initialize MQTT client: ${err.message}`);
  }
}

function handleIncoming(topic, payload) {
  // Any incoming traffic confirms active online connectivity
  store.setDeviceStatus("esp32", "online");
  store.setDeviceStatus(process.env.DEVICE_ID || "underconstruction-esp32", "online");
  store.setValue("esp32_status", "online", "");

  // If telemetry callback is provided and payload has sensor data
  const data = payload.values || payload.data || payload;
  const isTelemetryTopic = topic === topicValues() || topic.includes("telemetry") || topic.includes("values");
  const hasTelemetryKeys = data && typeof data === "object" && (
    data.voltage_V !== undefined || data.voltage !== undefined ||
    data.current_mA !== undefined || data.current !== undefined ||
    data.jib_yaw_deg !== undefined || data.yaw !== undefined
  );

  if (onTelemetryCallback && (isTelemetryTopic || hasTelemetryKeys)) {
    onTelemetryCallback(data);
  }

  // 1. Device Connectivity Status
  if (topic === topicStatus() || topic.includes("status") || topic === "v1/devices/me/attributes") {
    const status = payload.status || payload.value || "online";
    store.setDeviceStatus("esp32", status);
    store.setDeviceStatus(process.env.DEVICE_ID || "underconstruction-esp32", status);
    const updated = store.setValue("esp32_status", status, "");
    if (onUpdateCallback) onUpdateCallback("esp32_status", updated);
    return;
  }

  // 2. Actuator State Feedback (e.g. from physical crane ESP32)
  if (topic === topicActuatorState() || topic.includes("actuator")) {
    const actId = payload.actuator || payload.id || payload.item_id;
    const item = findItem(actId);
    const stateVal = payload.state !== undefined ? payload.state : payload.value;
    if (item && stateVal !== undefined) {
      const updated = store.setValue(item.id, stateVal, item.unit);
      if (onUpdateCallback) onUpdateCallback(item.id, updated);
    }
    return;
  }

  // 3. Telemetry values payload
  if (topic === topicValues() || topic.includes("telemetry") || topic.includes("values")) {
    for (const [key, val] of Object.entries(data)) {
      const item = findItem(key);
      if (item && val !== null && val !== undefined) {
        const updated = store.setValue(item.id, val, item.unit);
        if (onUpdateCallback) onUpdateCallback(item.id, updated);
      }
    }
  }
}

/**
 * Publish Actuator Command matching Cement Plant Pattern
 * @param {string} itemId - Target actuator ('crane_motion', 'magnet_state', 'crane_speed', 'crane', 'magnet')
 * @param {string|number} command - Action command ('forward', 'reverse', 'stop', 'on', 'off', speed number)
 */
function publishActuatorCommand(itemId, command) {
  const item = findItem(itemId);
  const targetId = item ? item.id : itemId;

  let rpcMethod = null;
  let wireCommand = String(command).toLowerCase().trim();

  if (targetId === "crane_motion" || itemId === "crane") {
    if (["forward", "cw", "clockwise", "1"].includes(wireCommand)) {
      wireCommand = "forward";
      rpcMethod = "setReverse"; // INVERTED: Physical crane wiring turns clockwise on setReverse
    } else if (["reverse", "ccw", "counterclockwise", "anticlockwise"].includes(wireCommand)) {
      wireCommand = "reverse";
      rpcMethod = "setForward"; // INVERTED: Physical crane wiring turns counter-clockwise on setForward
    } else {
      wireCommand = "stop";
      rpcMethod = "setStop";
    }
  } else if (targetId === "magnet_state" || itemId === "magnet") {
    if (["on", "1", "true"].includes(wireCommand)) {
      wireCommand = "on";
      rpcMethod = "setMagnetOn";
    } else {
      wireCommand = "off";
      rpcMethod = "setMagnetOff";
    }
  } else if (targetId === "crane_speed" || itemId === "speed") {
    const spd = Number(command);
    wireCommand = Number.isInteger(spd) ? spd : 180;
    rpcMethod = "setSpeed";
  }

  // Update in-memory live store & push to WebSocket clients
  const updated = store.setValue(targetId, wireCommand, item ? item.unit : "");
  if (onUpdateCallback) {
    onUpdateCallback(targetId, updated);
  }

  if (!client || !client.connected) {
    console.warn(`[MQTT] Client not connected, cannot publish to broker for ${targetId}`);
    return false;
  }

  try {
    // 1. Publish standard Cement Plant actuator payload
    const actuatorMsg = JSON.stringify({
      type: "actuator",
      actuator: targetId,
      command: wireCommand,
      ts: Date.now()
    });
    client.publish(topicActuatorCommand(), actuatorMsg, { qos: 1, retain: true });

    // 2. Publish standard ESP32 RPC method payload
    if (rpcMethod) {
      const rpcPayload = { method: rpcMethod };
      if (rpcMethod === "setSpeed") rpcPayload.params = wireCommand;
      client.publish(topicCommand(), JSON.stringify(rpcPayload), { qos: 1 });
    }

    console.log(`[MQTT] Published command for ${targetId} (${wireCommand}) to ${topicActuatorCommand()}`);
    return true;
  } catch (err) {
    console.error(`[MQTT] Failed to publish for ${targetId}:`, err.message);
    return false;
  }
}

function publish(subTopic, message) {
  if (!client || !client.connected) return false;
  const topic = subTopic.startsWith("v1/") ? subTopic : `${PREFIX}/${subTopic}`;
  const payload = typeof message === "string" ? message : JSON.stringify(message);
  client.publish(topic, payload, { qos: 1 });
  return true;
}

module.exports = {
  connect,
  publish,
  publishActuatorCommand,
  topicCommand,
  topicValues,
  topicStatus,
  topicActuatorCommand,
  topicActuatorState
};
