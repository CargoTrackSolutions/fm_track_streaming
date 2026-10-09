// -----------------------------------------------------------------------------
// fm-track client
//
// Flow (as recommended by the fm-track docs):
//   1. GET /api/fm-track/objects -> learn which objects exist + their names
//   2. GET /api/fm-track/stream  -> open an SSE stream, positions arrive live
//
// Every coordinate record is converted to the app's common vehicle shape
// (see toVehicle) and handed to ui.upsert().
//
// IP whitelist: fm-track only answers requests from whitelisted IP addresses,
// i.e. the public IP of the machine running server.js. A 401 means a wrong
// API key; any other failure (403, timeout, connection error, 5xx) is treated
// as "not reachable" and the user is told to ask CargoTrack for a whitelist.
// -----------------------------------------------------------------------------

const NOT_REACHABLE =
  "The fm-track API could not be reached. Access is limited to whitelisted IP " +
  "addresses: contact CargoTrack (office@cargotrack.ro) to whitelist the public " +
  "IP of the machine running this server.";

// fm-track coordinate record -> common vehicle shape used by app.js.
function toVehicle(coord) {
  const pos = coord.position || {};
  return {
    id: coord.object_id,
    lat: pos.latitude,
    lng: pos.longitude,
    speed: pos.speed,
    ignition: coord.ignition_status,
    time: coord.datetime ? new Date(coord.datetime) : null,
    raw: coord, // full record, shown in the popup
  };
}

export default {
  id: "fm-track",
  label: "FM-TRACK-API",
  description: "Object API + Coordinates Streaming API (SSE).",
  fields: [{ name: "apiKey", label: "API key", type: "password", placeholder: "FM_TRACK_API_KEY" }],

  // Starts the integration; returns a function that stops it.
  start(creds, ui) {
    let source = null;
    let stopped = false;
    const key = creds.apiKey || "";

    (async () => {
      // --- Step 1: load the object list --------------------------------------
      try {
        const res = await fetch("/api/fm-track/objects", {
          headers: key ? { "X-Api-Key": key } : {},
        });
        if (stopped) return;
        if (res.status === 401) {
          ui.authFailed(key ? "invalid API key" : "enter API key");
          return;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        // The Object API returns a single object or a list of objects.
        const list = Array.isArray(data) ? data : [data];
        for (const o of list) {
          const id = o.object_id || o.id;
          if (id) ui.setName(id, o.name || id);
        }
      } catch (err) {
        console.error("Failed to load objects:", err);
        if (!stopped) ui.setStatus("API not reachable", "error", NOT_REACHABLE);
        return;
      }
      if (stopped) return;

      // --- Step 2: subscribe to the coordinate stream ------------------------
      // EventSource is the browser's built-in SSE client. It reconnects on its
      // own if the connection drops, which is what the fm-track docs recommend.
      // It can't send headers, so the key goes in the query string.
      source = new EventSource(
        "/api/fm-track/stream" + (key ? "?api_key=" + encodeURIComponent(key) : "")
      );

      source.onopen = () => ui.setStatus("streaming live", "live");

      source.onmessage = (event) => {
        try {
          const coord = JSON.parse(event.data);
          if (coord.object_id) ui.upsert(toVehicle(coord));
        } catch (err) {
          console.error("Bad message:", event.data, err);
        }
      };

      source.onerror = () => {
        // The browser will retry automatically; just reflect it in the UI.
        ui.setStatus("reconnecting…", "connecting");
      };
    })();

    return () => {
      stopped = true;
      if (source) source.close();
    };
  },
};
