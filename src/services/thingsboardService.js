// ThingsBoard Service (matching Cement Plant implementation)
// -----------------------------------------------------------------------------
let jwtToken = null;
let tokenExpiry = 0;

function getConfig() {
  return {
    url: (process.env.THINGSBOARD_URL || "http://allcad-chennai.selfip.com:8081").replace(/\/$/, ""),
    username: process.env.THINGSBOARD_USERNAME || "tenant@thingsboard.org",
    password: process.env.THINGSBOARD_PASSWORD || "tenant",
    token: process.env.THINGSBOARD_TOKEN || process.env.DEVICE_ID || "underconstruction-esp32",
    deviceId: process.env.THINGSBOARD_DEVICE_ID || ""
  };
}

// Authenticate with ThingsBoard REST API
async function authenticate() {
  const cfg = getConfig();
  if (!cfg.url || !cfg.username) return null;
  if (jwtToken && Date.now() < tokenExpiry) return jwtToken;

  try {
    const res = await fetch(`${cfg.url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: cfg.username, password: cfg.password })
    });
    if (!res.ok) {
      console.warn(`[ThingsBoard API] Auth failed (${res.status}): ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    if (data.token) {
      jwtToken = data.token;
      tokenExpiry = Date.now() + 2 * 60 * 60 * 1000;
      console.log("[ThingsBoard API] Authenticated successfully with ThingsBoard server.");
      return jwtToken;
    }
  } catch (err) {
    console.warn("[ThingsBoard API] Network error authenticating:", err.message);
  }
  return null;
}

// Forward device telemetry to ThingsBoard
async function sendTelemetry(deviceToken, telemetry) {
  const cfg = getConfig();
  const token = deviceToken || cfg.token;
  if (!cfg.url || !token) return false;

  try {
    const url = `${cfg.url}/api/v1/${encodeURIComponent(token)}/telemetry`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telemetry)
    });
    if (res.ok) {
      return true;
    } else {
      console.warn(`[ThingsBoard API] Failed to forward telemetry (${res.status}): ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`[ThingsBoard API] Error forwarding telemetry for ${token}:`, err.message);
  }
  return false;
}

// Publish shared attributes
async function publishAttributes(attributes, deviceId) {
  const cfg = getConfig();
  const targetId = deviceId || cfg.deviceId;
  if (!cfg.url || !targetId) return false;

  const authToken = await authenticate();
  if (!authToken) return false;

  try {
    const res = await fetch(`${cfg.url}/api/plugins/telemetry/DEVICE/${targetId}/SHARED_SCOPE`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify(attributes)
    });
    return res.ok;
  } catch (err) {
    console.warn("[ThingsBoard API] Error publishing attributes:", err.message);
  }
  return false;
}

module.exports = {
  authenticate,
  sendTelemetry,
  publishAttributes
};

