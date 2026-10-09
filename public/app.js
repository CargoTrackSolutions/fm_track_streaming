// -----------------------------------------------------------------------------
// Front-end shell: map, sidebar and connection form, shared by all APIs.
//
// Each API lives in its own module under providers/. A provider declares the
// credential fields it needs (stored under credsKey, if several entries share
// one account) and a start(creds, ui) function. It converts the
// API's records into one common vehicle shape and hands them to ui.upsert():
//
//   { id, name?, lat, lng, speed?, ignition?, time: Date | null, raw }
//
// `raw` is the untouched API record; the popup shows every field of it.
// -----------------------------------------------------------------------------

import fmTrack from "./providers/fm-track.js";
import { atlas, ddata } from "./providers/cargotrack.js";

const PROVIDERS = [atlas, ddata, fmTrack];

// --- Map setup ---------------------------------------------------------------
// Centered roughly on Romania; the view auto-fits once real positions arrive.
const map = L.map("map").setView([45.9432, 24.9668], 6);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// --- State -------------------------------------------------------------------
const markers = {}; // id -> Leaflet marker
const names = {}; // id -> display name
const lastKey = {}; // id -> last seen position time (used for de-duplication)
const lastVehicle = {}; // id -> last vehicle record
const receivedAt = {}; // id -> Date the last record arrived in the browser
let hasFittedBounds = false;
let stopProvider = null; // stops the running provider
let session = 0; // bumped on every (re)connect; stale callbacks are ignored

// --- Small helpers -----------------------------------------------------------
// `detail` is an optional longer explanation shown under the badge.
function setStatus(text, kind, detail) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = "status status--" + kind;
  const detailEl = document.getElementById("status-detail");
  detailEl.textContent = detail || "";
  detailEl.hidden = !detail;
}

// Escape user/API-supplied text before injecting it into innerHTML.
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
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

const hasFix = (v) =>
  v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && !(v.lat === 0 && v.lng === 0);

// Build the popup shown on the map: vehicle name, when the data arrived, and a
// table of the full raw record.
function buildPopup(id, v) {
  const arrivedDate = receivedAt[id] || null;
  const arrived = arrivedDate ? arrivedDate.toLocaleString() : "—";

  // The record's own timestamp (device/server side), shown in local time.
  const posDate = v && v.time && !isNaN(v.time) ? v.time : null;
  const positionDate = posDate ? posDate.toLocaleString() : "—";

  const rows = flatten(v && v.raw)
    .map(
      ([k, val]) =>
        `<tr><td class="pk">${escapeHtml(k)}</td><td class="pv">${escapeHtml(val)}</td></tr>`
    )
    .join("");

  return (
    `<div class="veh-popup">` +
    `<div class="veh-popup-title">${escapeHtml(names[id] || id)}</div>` +
    `<div class="veh-popup-meta">Received: ${escapeHtml(arrived)}</div>` +
    `<div class="veh-popup-meta">Position date: ${escapeHtml(positionDate)}</div>` +
    `<table class="veh-popup-table">${rows}</table>` +
    `</div>`
  );
}

// Build / update the row shown in the left sidebar for one vehicle.
function updateSidebar(id) {
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

  const v = lastVehicle[id];
  const meta = [];
  if (v) {
    meta.push(hasFix(v) ? Math.round(v.speed || 0) + " km/h" : "no GPS fix");
    if (v.ignition) meta.push(v.ignition);
    meta.push(v.time && !isNaN(v.time) ? v.time.toLocaleTimeString() : "—");
  } else {
    meta.push("waiting for position…");
  }

  row.innerHTML =
    `<span class="veh-name">${escapeHtml(names[id] || id)}</span>` +
    `<span class="veh-meta">${escapeHtml(meta.join(" · "))}</span>`;
}

// Create or move the map marker for one vehicle.
function placeMarker(id, v) {
  const popup = buildPopup(id, v);

  if (markers[id]) {
    markers[id].setLatLng([v.lat, v.lng]).setPopupContent(popup);
  } else {
    // Leaflet caps popup width at 300px by default; widen it for long field names.
    markers[id] = L.marker([v.lat, v.lng])
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

// --- Callbacks handed to providers --------------------------------------------
function setName(id, name) {
  names[id] = name;
  updateSidebar(id);
}

function upsert(v) {
  const id = v.id;
  if (v.name) names[id] = v.name;

  // De-duplication: fm-track re-sends the last known coordinate on every
  // (re)connect, and polling returns the same record until a new one exists.
  const key = v.time ? v.time.getTime() : JSON.stringify(v.raw);
  if (lastKey[id] === key) return;
  lastKey[id] = key;

  // Remember the record and when it arrived so the popup can show it all.
  lastVehicle[id] = v;
  receivedAt[id] = new Date();

  updateSidebar(id);

  // 0/0 means the device has no GPS fix yet – don't drop a marker in the ocean.
  if (hasFix(v)) placeMarker(id, v);
}

// --- Connection form ------------------------------------------------------------
// Credentials are remembered in this browser's localStorage for convenience.
// That's fine for a local demo; a production app should not store passwords there.
const STORAGE_PREFIX = "integrationDemo.";

function load(key, fallback) {
  try {
    const value = localStorage.getItem(STORAGE_PREFIX + key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage blocked – the values still work for this page load.
  }
}

const providerSelect = document.getElementById("provider");
const fieldsBox = document.getElementById("provider-fields");

const currentProvider = () =>
  PROVIDERS.find((p) => p.id === providerSelect.value) || PROVIDERS[0];

// Render the credential inputs the selected provider declares.
function renderFields() {
  const provider = currentProvider();
  const saved = load("creds." + (provider.credsKey || provider.id), {});
  fieldsBox.innerHTML = "";

  for (const f of provider.fields) {
    const id = "field-" + f.name;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = f.label;

    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      for (const [value, text] of f.options) input.add(new Option(text, value));
    } else {
      input = document.createElement("input");
      input.type = f.type;
      input.spellcheck = false;
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    input.id = id;
    input.name = f.name;
    if (saved[f.name] !== undefined) input.value = saved[f.name];

    fieldsBox.append(label, input);
  }

  document.getElementById("provider-description").textContent = provider.description;
}

function readFields() {
  const creds = {};
  for (const f of currentProvider().fields) {
    const value = document.getElementById("field-" + f.name).value;
    creds[f.name] = f.type === "password" ? value : value.trim();
  }
  return creds;
}

// Clear the map and sidebar, then start the selected provider.
function connect() {
  if (stopProvider) stopProvider();
  for (const m of Object.values(markers)) map.removeLayer(m);
  for (const obj of [markers, names, lastKey, lastVehicle, receivedAt]) {
    for (const k of Object.keys(obj)) delete obj[k];
  }
  document.getElementById("vehicle-list").innerHTML = "";
  hasFittedBounds = false;

  const provider = currentProvider();
  const creds = readFields();
  save("provider", provider.id);
  save("creds." + (provider.credsKey || provider.id), creds);

  // Callbacks from a previous connection are ignored once a new one starts.
  const mine = ++session;
  const live = (fn) => (...args) => {
    if (mine === session) fn(...args);
  };

  setStatus("connecting…", "connecting");
  stopProvider = provider.start(creds, {
    setStatus: live(setStatus),
    setName: live(setName),
    upsert: live(upsert),
    authFailed: live((message) => {
      setStatus(message, "error");
      fieldsBox.querySelector("input")?.focus();
    }),
  });
}

// --- Boot --------------------------------------------------------------------
for (const p of PROVIDERS) providerSelect.add(new Option(p.label, p.id));
providerSelect.value = load("provider", PROVIDERS[0].id);
if (!providerSelect.value) providerSelect.value = PROVIDERS[0].id;
renderFields();

providerSelect.addEventListener("change", () => {
  renderFields();
  connect();
});
document.getElementById("conn-form").addEventListener("submit", (event) => {
  event.preventDefault();
  connect();
});
connect();
