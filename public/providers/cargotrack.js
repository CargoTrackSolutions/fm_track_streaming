// -----------------------------------------------------------------------------
// CargoTrack client (https://api.cargotrack.ro/docs)
//
// CargoTrack has no streaming endpoint, so this client POLLS the latest
// positions. Two ways to get them, offered as two entries in the API dropdown:
//
//   ATLAS-API: 1. /api/cargotrack/devices   -> device names (once)
//              2. /api/cargotrack/positions -> latest positions (every POLL_MS)
//   DDATA-API: /api/cargotrack/positions    -> latest positions incl. name and
//              all raw IO values (every POLL_MS)
//
// Every record is converted to the app's common vehicle shape (see
// fromAtlas / fromDdata) and handed to ui.upsert().
// -----------------------------------------------------------------------------

// The API allows 10 requests / minute; 30 s keeps us well below that.
const POLL_MS = 30_000;

// atlas: { deviceId, coordinate: { latitude, longitude }, heading, speed,
//          ignitionState, dateTime: { year, month, day, hour, minute, seconds, timezone: "UTC" } }
function fromAtlas(p) {
  const t = p.dateTime;
  return {
    id: p.deviceId,
    lat: p.coordinate?.latitude,
    lng: p.coordinate?.longitude,
    speed: p.speed,
    ignition: p.ignitionState,
    time: t ? new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.seconds)) : null,
    raw: p, // full record, shown in the popup
  };
}

// ddata: { name, imei, datetime: "YYYY-MM-DD HH:MM:SS" (UTC), latitude, longitude,
//          altitude, course, speed, sat, io…: raw IO values }
// The imei is the same value as atlas' deviceId.
function fromDdata(r) {
  return {
    id: r.imei,
    name: r.name,
    lat: r.latitude,
    lng: r.longitude,
    speed: r.speed,
    time: r.datetime ? new Date(r.datetime.replace(" ", "T") + "Z") : null,
    raw: r,
  };
}

// One provider per endpoint ("atlas" or "ddata"); both use the same account.
function makeProvider(endpoint, label, description) {
  return {
    id: endpoint,
    label,
    description: description + ", polled every " + POLL_MS / 1000 + " s.",
    credsKey: "cargotrack", // username/password are shared by both entries
    fields: [
      { name: "username", label: "Username", type: "text" },
      { name: "password", label: "Password", type: "password" },
    ],
    start: (creds, ui) => start(endpoint, creds, ui),
  };
}

export const atlas = makeProvider("atlas", "ATLAS-API", "CargoTrack atlas: devices + positions");
export const ddata = makeProvider("ddata", "DDATA-API", "CargoTrack ddata: position with raw IO data");

// Starts the integration; returns a function that stops it.
function start(endpoint, creds, ui) {
  let timer = null;
  let stopped = false;

  // Calls our backend proxy; credentials travel in the JSON body.
  function call(path, extra) {
    return fetch("/api/cargotrack/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: creds.username, password: creds.password, ...extra }),
    });
  }

  // Returns false when polling must stop (bad credentials).
  function handleError(res) {
    if (res.status === 401) ui.authFailed("enter username and password");
    else if (res.status === 403) ui.authFailed("invalid username or password");
    else if (res.status === 429) {
      ui.setStatus("rate limited – retrying", "connecting");
      return true;
    } else ui.setStatus("API error " + res.status + " – retrying", "connecting");
    return res.status !== 401 && res.status !== 403;
  }

  async function loadDevices() {
    const res = await call("devices");
    if (!res.ok) return handleError(res);
    const data = await res.json();
    for (const d of data.deviceList || []) ui.setName(d.deviceId, d.deviceName || d.deviceId);
    return true;
  }

  async function poll() {
    try {
      const res = await call("positions", { endpoint });
      if (stopped) return;
      if (!res.ok) {
        if (!handleError(res)) return;
      } else {
        const data = await res.json();
        const vehicles =
          endpoint === "atlas" ? (data.positionList || []).map(fromAtlas) : data.map(fromDdata);
        for (const v of vehicles) if (v.id) ui.upsert(v);
        ui.setStatus(
          "updated " + new Date().toLocaleTimeString() + " · every " + POLL_MS / 1000 + " s",
          "live"
        );
      }
    } catch (err) {
      console.error("Poll failed:", err);
      ui.setStatus("network error – retrying", "connecting");
    }
    if (!stopped) timer = setTimeout(poll, POLL_MS);
  }

  (async () => {
    try {
      if (endpoint === "atlas" && !(await loadDevices())) return;
    } catch (err) {
      console.error("Failed to load devices:", err);
    }
    if (!stopped) poll();
  })();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
