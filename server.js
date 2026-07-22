// -----------------------------------------------------------------------------
// fm-track demo backend
//
// Why a backend at all?
//   The browser could technically call the fm-track API directly (see the SSE
//   example in the official docs). In practice that has two problems for a real
//   client integration:
//     1. CORS – api.fm-track.com does not send the headers a browser needs to
//        read a cross-origin response, so a pure front-end call is blocked.
//     2. Security – putting the api_key in front-end code exposes it to anyone.
//
//   So this tiny Express server acts as a proxy: it holds the api_key and
//   forwards two things to the browser on the SAME origin:
//     GET /api/objects        -> the Object API (list of vehicles)
//     GET /api/stream         -> the Object Coordinates Streaming API (SSE)
// -----------------------------------------------------------------------------

import express from "express";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load variables from a local .env file if present (Node >= 20.12 built-in, no
// dependency). If there is no .env we fall back to the real process environment.
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  // No .env file – rely on environment variables set in the shell instead.
}

// The API key MUST come from the environment (.env or a real env var). It is
// never hard-coded so it can't leak into version control.
const API_KEY = process.env.FM_TRACK_API_KEY;
const BASE_URL = process.env.FM_TRACK_BASE_URL || "https://api.fm-track.com";
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error(
    "Missing FM_TRACK_API_KEY.\n" +
      "Copy .env.example to .env and set your key, e.g.:\n" +
      "  FM_TRACK_API_KEY=your-api-key-here"
  );
  process.exit(1);
}

const app = express();

// Serve the static front-end (index.html, app.js, style.css) from /public.
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------------------------------------------------------
// 1) Object API proxy
//    Returns the list of the client's objects (vehicles). The front-end uses
//    this mainly to map object_id -> a human-readable name.
// -----------------------------------------------------------------------------
app.get("/api/objects", async (_req, res) => {
  try {
    const url = new URL("/objects", BASE_URL);
    url.searchParams.set("version", "1");
    url.searchParams.set("api_key", API_KEY);

    const upstream = await fetch(url, {
      headers: { "Content-Type": "application/json;charset=UTF-8" },
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({ error: "Object API error", body });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error("[/api/objects]", err);
    res.status(502).json({ error: String(err) });
  }
});

// -----------------------------------------------------------------------------
// 2) Object Coordinates Streaming API proxy (Server-Sent Events)
//    We open ONE long-lived HTTP GET to fm-track and pipe the raw event stream
//    straight through to the browser's EventSource. If object_id is given we
//    stream a single object, otherwise all of the client's objects.
// -----------------------------------------------------------------------------
app.get("/api/stream", async (req, res) => {
  const { object_id } = req.query;

  const url = new URL("/object-coordinates-stream", BASE_URL);
  url.searchParams.set("version", "1");
  url.searchParams.set("api_key", API_KEY);
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
      console.error("[/api/stream] upstream stream error", err);
      res.end();
    });
    upstreamStream.pipe(res);
  } catch (err) {
    if (controller.signal.aborted) return; // normal client disconnect
    console.error("[/api/stream]", err);
    if (!res.headersSent) res.status(502).json({ error: String(err) });
    else res.end();
  }
});

app.listen(PORT, () => {
  console.log(`fm-track demo running at http://localhost:${PORT}`);
});
