// In-memory live state store (Architecture matching Cement Plant model)
// -----------------------------------------------------------------------------
const { allItemIds, findItem } = require("../config/itemRegistry");

const state = new Map();
const deviceState = new Map();

// Pre-populate registered items
allItemIds().forEach(id => {
  const item = findItem(id);
  state.set(id, {
    item_id: id,
    name: item ? item.name : id,
    value: null,
    unit: item ? item.unit : "",
    type: item ? item.type : "sensor",
    ts: null
  });
});

function setValue(id, value, unit) {
  const item = findItem(id);
  const resolvedId = item ? item.id : id;
  const existing = state.get(resolvedId) || { item_id: resolvedId };
  const updated = {
    ...existing,
    name: item ? item.name : existing.name || resolvedId,
    type: item ? item.type : existing.type || "sensor",
    value,
    unit: unit !== undefined ? unit : (item ? item.unit : existing.unit || ""),
    ts: Date.now()
  };
  state.set(resolvedId, updated);
  return updated;
}

function get(id) {
  const item = findItem(id);
  const resolvedId = item ? item.id : id;
  return state.get(resolvedId) || null;
}

function all() {
  const out = {};
  for (const [id, val] of state.entries()) {
    out[id] = val;
  }
  return out;
}

function setDeviceStatus(device, status) {
  const updated = { status, lastSeen: Date.now() };
  deviceState.set(device, updated);
  return updated;
}

function getDeviceStatus(device) {
  return deviceState.get(device) || { status: "unknown", lastSeen: null };
}

function allDevices() {
  const out = {};
  for (const [device, status] of deviceState.entries()) {
    out[device] = status;
  }
  return out;
}

module.exports = {
  setValue,
  get,
  all,
  setDeviceStatus,
  getDeviceStatus,
  allDevices
};

