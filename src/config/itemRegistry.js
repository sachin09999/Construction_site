// Item Registry for Crane Digital Twin (Architecture matching Cement Plant model)
// -----------------------------------------------------------------------------
const ITEM_REGISTRY = [
  // Electrical sensors
  { id: "voltage_V", name: "Supply Voltage", type: "sensor", unit: "V", alias: ["voltage", "supply_voltage"] },
  { id: "current_mA", name: "Motor Current", type: "sensor", unit: "mA", alias: ["current", "motor_current"] },
  { id: "power_mW", name: "Power", type: "sensor", unit: "mW", alias: ["power", "power_consumption"] },

  // Orientation & motion sensors
  { id: "jib_yaw_deg", name: "Jib Yaw", type: "sensor", unit: "°", alias: ["yaw", "jib_yaw", "rotation"] },
  { id: "jib_deflection_deg", name: "Jib Deflection", type: "sensor", unit: "°", alias: ["deflection", "tilt", "jib_deflection"] },

  // Operational metrics
  { id: "current_session_time_sec", name: "Session Time", type: "sensor", unit: "s", alias: ["session_time", "uptime"] },
  { id: "total_operation_time_sec", name: "Total Operation Time", type: "sensor", unit: "s", alias: ["total_time", "runtime"] },

  // Sensor diagnostics (health)
  { id: "mpu_ok", name: "MPU6500 Health", type: "sensor", unit: "", alias: ["mpu", "mpu_health"] },
  { id: "mag_ok", name: "Magnetometer Health", type: "sensor", unit: "", alias: ["mag", "mag_health"] },
  { id: "ina226_ok", name: "INA226 Health", type: "sensor", unit: "", alias: ["ina226", "ina_health"] },

  // Actuator states
  { id: "crane_speed", name: "Crane Motor Speed", type: "actuator", unit: "PWM", alias: ["speed", "motor_speed"] },
  { id: "crane_motion", name: "Crane Direction", type: "actuator", unit: "", alias: ["direction", "motion"] },
  { id: "magnet_state", name: "Magnet Relay", type: "actuator", unit: "", alias: ["magnet", "magnet_relay"] },

  // Device status
  { id: "esp32_status", name: "Crane ESP32 Status", type: "sensor", unit: "", alias: ["status", "device_status"] },
  { id: "firmware_version", name: "Firmware Version", type: "sensor", unit: "", alias: ["firmware", "fw"] },
  { id: "last_command", name: "Last Command", type: "sensor", unit: "", alias: ["command"] }
];

function findItem(id) {
  if (!id) return null;
  const key = String(id).toLowerCase().trim();
  return ITEM_REGISTRY.find(item => 
    item.id.toLowerCase() === key || 
    (item.alias && item.alias.some(a => a.toLowerCase() === key))
  ) || null;
}

function allItemIds() {
  return ITEM_REGISTRY.map(item => item.id);
}

module.exports = { ITEM_REGISTRY, findItem, allItemIds };

