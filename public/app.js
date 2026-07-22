// -----------------------------------------------------------------------------
// Front-end: fetch the object list, then subscribe to the live coordinate
// stream and draw every incoming position on an OpenStreetMap map.
//
// Flow (as recommended by the fm-track docs):
//   1. GET /api/objects  -> learn which objects exist + their names
//   2. GET /api/stream   -> open an SSE stream and update markers in real time
// -----------------------------------------------------------------------------

// --- Map setup ---------------------------------------------------------------
// Centered roughly on Romania; the view auto-fits once real positions arrive.
const map = L.map("map").setView([45.9432, 24.9668], 6);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// --- State -------------------------------------------------------------------
const markers = {}; // object_id -> Leaflet marker
const names = {}; // object_id -> display name (from the Object API)
const lastKey = {}; // object_id -> last seen "datetime" (used for de-duplication)
const lastCoord = {}; // object_id -> last full coordinate record
const receivedAt = {}; // object_id -> Date the last record arrived in the browser
let hasFittedBounds = false;

// --- Small helpers -----------------------------------------------------------
function setStatus(text, cssClass) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = "status " + cssClass;
}

// Escape user/API-supplied text before injecting it into innerHTML.
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// Human-readable duration for the "Delay" line, e.g. 1250 -> "1 s", 65000 -> "1 min 5 s".
function formatDuration(ms) {
  if (!isFinite(ms)) return "—";
  const negative = ms < 0;
  let total = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  total -= h * 3600;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  const parts = [];
  if (h) parts.push(h + " h");
  if (m) parts.push(m + " min");
  parts.push(s + " s");
  return (negative ? "-" : "") + parts.join(" ");
}

// Flatten a (possibly nested) object into [label, value] pairs so we can render
// EVERY field the API sends, e.g. position.latitude, position.speed, …
function flatten(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj || {})) {
    const label = prefix ? prefix + "." + k : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, label, out);
    } else if (Array.isArray(v)) {
      out.push([label, JSON.stringify(v)]);
    } else {
      out.push([label, v === null || v === undefined ? "—" : v]);
    }
  }
  return out;
}

// Build the popup shown on the map: vehicle name, when the data arrived, and a
// table of the full last coordinate record.
function buildPopup(id, coord) {
  const name = names[id] || id;

  const arrivedDate = receivedAt[id] || null;
  const arrived = arrivedDate ? arrivedDate.toLocaleString() : "—";

  // The record's own timestamp (device/server side), shown in local time.
  const posDate = coord && coord.datetime ? new Date(coord.datetime) : null;
  const positionDate = posDate ? posDate.toLocaleString() : "—";

  // Lag = how far behind the position time was by the time it reached us.
  const delay =
    posDate && arrivedDate ? formatDuration(arrivedDate - posDate) : "—";

  // object_id -> shown as the title; datetime -> shown as "Position date" above.
  const rows = flatten(coord)
    .filter(([k]) => k !== "object_id" && k !== "datetime")
    .map(
      ([k, v]) =>
        `<tr><td class="pk">${escapeHtml(k)}</td><td class="pv">${escapeHtml(v)}</td></tr>`
    )
    .join("");

  return (
    `<div class="veh-popup">` +
    `<div class="veh-popup-title">${escapeHtml(name)}</div>` +
    `<div class="veh-popup-meta">Received: ${escapeHtml(arrived)}</div>` +
    `<div class="veh-popup-meta">Position date: ${escapeHtml(positionDate)}</div>` +
    `<div class="veh-popup-meta">Delay: ${escapeHtml(delay)}</div>` +
    `<table class="veh-popup-table">${rows}</table>` +
    `</div>`
  );
}

// Build / update the row shown in the left sidebar for one vehicle.
function updateSidebar(id, coord) {
  const list = document.getElementById("vehicle-list");
  let row = document.getElementById("veh-" + id);
  if (!row) {
    row = document.createElement("li");
    row.id = "veh-" + id;
    row.className = "vehicle";
    row.addEventListener("click", () => {
      const m = markers[id];
      if (m) {
        map.setView(m.getLatLng(), 14);
        m.openPopup(); // show the full-data popup on the map
      }
    });
    list.appendChild(row);
  }

  const name = names[id] || id;
  const pos = coord && coord.position;
  const hasFix = pos && !(pos.latitude === 0 && pos.longitude === 0);
  const speed = pos ? Math.round(pos.speed || 0) : 0;
  const ignition = coord ? coord.ignition_status : "UNKNOWN";
  const when = coord ? new Date(coord.datetime).toLocaleTimeString() : "—";

  row.innerHTML =
    `<span class="veh-name">${name}</span>` +
    `<span class="veh-meta">${hasFix ? speed + " km/h" : "no GPS fix"} · ${ignition} · ${when}</span>`;
}

// Create or move the map marker for one vehicle.
function placeMarker(id, lat, lng, coord) {
  const popup = buildPopup(id, coord);

  if (markers[id]) {
    markers[id].setLatLng([lat, lng]).setPopupContent(popup);
  } else {
    // Leaflet caps popup width at 300px by default; widen it for long sensor names.
    markers[id] = L.marker([lat, lng])
      .addTo(map)
      .bindPopup(popup, { maxWidth: 460, minWidth: 320 });
  }

  // Zoom to show all vehicles the first time we get real coordinates.
  if (!hasFittedBounds) {
    const all = Object.values(markers).map((m) => m.getLatLng());
    if (all.length) {
      map.fitBounds(L.latLngBounds(all).pad(0.2));
      hasFittedBounds = true;
    }
  }
}

// --- Handle one streamed coordinate record -----------------------------------
function handleCoordinate(coord) {
  const id = coord.object_id;
  if (!id) return;

  // De-duplication: the API always re-sends the last known coordinate on
  // (re)connect, so the same object_id + datetime can arrive more than once.
  const key = coord.datetime;
  if (lastKey[id] === key) return;
  lastKey[id] = key;

  // Remember the full record and when it arrived so the popup can show it all.
  lastCoord[id] = coord;
  receivedAt[id] = new Date();

  updateSidebar(id, coord);

  const pos = coord.position || {};
  // 0/0 means the device has no GPS fix yet – don't drop a marker in the ocean.
  if (pos.latitude === 0 && pos.longitude === 0) return;

  placeMarker(id, pos.latitude, pos.longitude, coord);
}

// --- Step 1: load the object list -------------------------------------------
async function loadObjects() {
  try {
    const res = await fetch("/api/objects");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    // The Object API returns a single object or a list of objects.
    const list = Array.isArray(data) ? data : [data];
    for (const o of list) {
      const id = o.object_id || o.id;
      if (!id) continue;
      names[id] = o.name || id;
      updateSidebar(id, null); // pre-populate the sidebar before positions arrive
    }
  } catch (err) {
    console.error("Failed to load objects:", err);
  }
}

// --- Step 2: subscribe to the coordinate stream ------------------------------
function connectStream() {
  // EventSource is the browser's built-in SSE client. It reconnects on its own
  // if the connection drops, which is exactly what the fm-track docs recommend.
  const source = new EventSource("/api/stream");

  source.onopen = () => setStatus("streaming live", "status--live");

  source.onmessage = (event) => {
    try {
      handleCoordinate(JSON.parse(event.data));
    } catch (err) {
      console.error("Bad message:", event.data, err);
    }
  };

  source.onerror = () => {
    // The browser will retry automatically; just reflect it in the UI.
    setStatus("reconnecting…", "status--connecting");
  };
}

// --- Boot --------------------------------------------------------------------
(async function main() {
  await loadObjects();
  connectStream();
})();
