// -----------------------------------------------------------------------------
// CargoTrack proxy (https://api.cargotrack.ro/docs)
//   POST /api/cargotrack/devices    -> GET  /atlas/{username}/devices
//   POST /api/cargotrack/positions  -> GET  /atlas/{username}/positions   (endpoint: "atlas")
//                                   -> POST /ddata/1.0/position           (endpoint: "ddata")
//
// Auth: username + password. The browser sends them in a JSON body to this
// server; we attach them to the upstream call the way each endpoint expects
// (atlas: username in the path, password in the query; ddata: JSON body).
// CARGOTRACK_USERNAME / CARGOTRACK_PASSWORD from .env are used only when the
// browser sends neither.
//
// CargoTrack has no streaming endpoint: the front-end polls /positions.
// Mind the rate limit (X-RateLimit-Limit: 10 requests / minute).
// Status codes are passed through: 403 = wrong credentials, 429 = too many
// requests, 400 = missing parameters, 422 = unexpected upstream error.
// -----------------------------------------------------------------------------

import { Router } from "express";

const router = Router();

// Read lazily: server.js loads .env after this module is imported.
const baseUrl = () => process.env.CARGOTRACK_BASE_URL || "https://api.cargotrack.ro";

function credentialsFor(req) {
  const { username, password } = req.body || {};
  if (!username && !password) {
    return {
      username: String(process.env.CARGOTRACK_USERNAME || "").trim(),
      password: String(process.env.CARGOTRACK_PASSWORD || ""),
    };
  }
  return { username: String(username || "").trim(), password: String(password || "") };
}

function atlasUrl(username, password, resource) {
  const url = new URL(`/atlas/${encodeURIComponent(username)}/${resource}`, baseUrl());
  url.searchParams.set("password", password);
  return url;
}

// Call CargoTrack and relay its JSON (or its error status) to the browser.
async function relay(res, url, init, label) {
  try {
    const upstream = await fetch(url, init);
    const body = await upstream.text();
    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ error: `CargoTrack API error ${upstream.status}`, body });
    }
    res.type("application/json").send(body);
  } catch (err) {
    // Log only the error, never the URL: it contains the password.
    console.error(`[cargotrack ${label}]`, err.message);
    res.status(502).json({ error: String(err.message) });
  }
}

// -----------------------------------------------------------------------------
// 1) Device list (atlas)
//    Response: { deviceList: [ { deviceId, deviceName } ] }
// -----------------------------------------------------------------------------
router.post("/devices", (req, res) => {
  const { username, password } = credentialsFor(req);
  if (!username || !password) return res.status(401).json({ error: "Missing credentials" });

  relay(res, atlasUrl(username, password, "devices"), undefined, "/devices");
});

// -----------------------------------------------------------------------------
// 2) Latest positions, via either endpoint
//    atlas: { positionList: [ { deviceId, coordinate: { latitude, longitude },
//             heading, speed, ignitionState, dateTime: { year, month, day,
//             hour, minute, seconds, timezone } } ] }
//    ddata: [ { name, imei, datetime: "YYYY-MM-DD HH:MM:SS" (UTC), latitude,
//             longitude, altitude, course, speed, sat, io…: raw IO values } ]
// -----------------------------------------------------------------------------
router.post("/positions", (req, res) => {
  const { username, password } = credentialsFor(req);
  if (!username || !password) return res.status(401).json({ error: "Missing credentials" });

  const endpoint = req.body?.endpoint === "ddata" ? "ddata" : "atlas";

  if (endpoint === "atlas") {
    return relay(res, atlasUrl(username, password, "positions"), undefined, "/positions atlas");
  }

  relay(
    res,
    new URL("/ddata/1.0/position", baseUrl()),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    "/positions ddata"
  );
});

export default router;
