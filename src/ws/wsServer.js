// WebSocket Server for Crane Digital Twin & Widgets (Cement Plant Architecture)
// -----------------------------------------------------------------------------
const WebSocket = require("ws");

const subscriptions = new Map(); // ws -> Set of item_ids ("*" means all)
let wssInstance = null;

function attach(server, getStateFn) {
  wssInstance = new WebSocket.Server({ server, path: "/ws" });

  wssInstance.on("connection", (ws) => {
    subscriptions.set(ws, new Set(["*"])); // Default: receive all

    // Send initial snapshot
    if (typeof getStateFn === "function") {
      try {
        const state = getStateFn();
        ws.send(JSON.stringify({
          type: "snapshot",
          state,
          timestamp: new Date().toISOString()
        }));
      } catch (e) {}
    }

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      if (msg.type === "subscribe") {
        const rawIds = msg.items || msg.item_id || msg.item_ids;
        if (rawIds) {
          const idList = Array.isArray(rawIds)
            ? rawIds
            : typeof rawIds === "string"
            ? rawIds.split(",").map((s) => s.trim())
            : [rawIds];
          subscriptions.set(ws, new Set(idList));
        }
      }
    });

    ws.on("close", () => subscriptions.delete(ws));
    ws.on("error", () => subscriptions.delete(ws));
  });

  return wssInstance;
}

// Broadcasts item update in Cement Plant format ({ type: "update", item_id, value, ... })
function broadcastItem(item_id, data) {
  const message = JSON.stringify({ type: "update", item_id, ...data });

  for (const [ws, wanted] of subscriptions.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (wanted.has("*") || wanted.has(item_id)) {
      ws.send(message);
    }
  }
}

// Broadcasts generic payload to all connected clients
function broadcastRaw(type, data, state) {
  const message = JSON.stringify({
    type,
    data,
    state,
    timestamp: new Date().toISOString()
  });

  for (const [ws] of subscriptions.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

module.exports = {
  attach,
  broadcastItem,
  broadcastRaw
};

