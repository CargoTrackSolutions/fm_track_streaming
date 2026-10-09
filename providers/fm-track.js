// -----------------------------------------------------------------------------
// fm-track proxy
//   GET /api/fm-track/objects  -> Object API (list of vehicles)
//   GET /api/fm-track/stream   -> Object Coordinates Streaming API (SSE)
//
// Auth: an api_key, sent by the browser as the X-Api-Key header, or as
// ?api_key= for the stream (EventSource can't set headers). FM_TRACK_API_KEY
// from .env is used only when the browser sends no key.
// -----------------------------------------------------------------------------

import { Router } from "express";
import { Readable } from "node:stream";

const router = Router();

// Read lazily: server.js loads .env after this module is imported.
const baseUrl = () => process.env.FM_TRACK_BASE_URL || "https://api.fm-track.com";

function apiKeyFor(req) {
  return String(
    req.get("X-Api-Key") || req.query.api_key || process.env.FM_TRACK_API_KEY || ""
  ).trim();
}

// -----------------------------------------------------------------------------
// 1) Object API
//    Returns the list of the client's objects (vehicles). The front-end uses
//    this mainly to map object_id -> a human-readable name.
// -----------------------------------------------------------------------------
router.get("/objects", async (req, res) => {
  const apiKey = apiKeyFor(req);
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });

  try {
    const url = new URL("/objects", baseUrl());
    url.searchParams.set("version", "1");
    url.searchParams.set("api_key", apiKey);

    // Without an IP whitelist entry the request may just hang; give up after 15 s.
    const upstream = await fetch(url, {
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({ error: "Object API error", body });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error("[fm-track /objects]", err.message);
    res.status(err.name === "TimeoutError" ? 504 : 502).json({ error: String(err.message) });
  }
});

// -----------------------------------------------------------------------------
// 2) Object Coordinates Streaming API (Server-Sent Events)
//    We open ONE long-lived HTTP GET to fm-track and pipe the raw event stream
//    straight through to the browser's EventSource. If object_id is given we
//    stream a single object, otherwise all of the client's objects.
// -----------------------------------------------------------------------------
router.get("/stream", async (req, res) => {
  const { object_id } = req.query;
  const apiKey = apiKeyFor(req);
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });

  const url = new URL("/object-coordinates-stream", baseUrl());
  url.searchParams.set("version", "1");
  url.searchParams.set("api_key", apiKey);
  if (object_id) url.searchParams.set("object_id", String(object_id));

  // Abort the upstream request as soon as the browser disconnects.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const body = upstream.body ? await upstream.text() : "";
      return res.status(upstream.status || 502).json({ error: "Stream API error", body });
    }

    // Tell the browser this is an SSE stream and keep the connection open.
    res.setHeader("Content-Type", "text/event-stream;charset=UTF-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Pipe the upstream (web ReadableStream) into the response (Node stream).
    // When the browser disconnects we abort the upstream fetch, which makes this
    // stream emit an AbortError. Handle it here so a normal client disconnect
    // never crashes the whole server with an unhandled 'error' event.
    const upstreamStream = Readable.fromWeb(upstream.body);
    upstreamStream.on("error", (err) => {
      if (controller.signal.aborted) return; // normal client disconnect
      console.error("[fm-track /stream] upstream stream error", err);
      res.end();
    });
    upstreamStream.pipe(res);
  } catch (err) {
    if (controller.signal.aborted) return; // normal client disconnect
    console.error("[fm-track /stream]", err);
    if (!res.headersSent) res.status(502).json({ error: String(err) });
    else res.end();
  }
});

export default router;
