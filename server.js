// -----------------------------------------------------------------------------
// INTEGRATION DEMO backend
//
// Why a backend at all?
//   The browser talks only to this small Express server, which forwards each
//   request to the real tracking API. Two reasons:
//     1. CORS – api.fm-track.com does not send the headers a browser needs to
//        read a cross-origin response, so a pure front-end call is blocked.
//     2. Credentials – the API key / password is sent by the browser to THIS
//        server only (same origin) and attached to the upstream call here, so
//        it never ends up in third-party URLs or browser history.
//
//   Each API lives in its own file under providers/ and is mounted below:
//     /api/fm-track/*    -> providers/fm-track.js   (Object API + SSE stream)
//     /api/cargotrack/*  -> providers/cargotrack.js (atlas + ddata, polling)
// -----------------------------------------------------------------------------

import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fmTrack from "./providers/fm-track.js";
import cargoTrack from "./providers/cargotrack.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load variables from a local .env file if present (Node >= 20.12 built-in, no
// dependency). If there is no .env we fall back to the real process environment.
// Credentials are normally entered in the app UI; .env only provides fallbacks.
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  // No .env file – rely on environment variables set in the shell instead.
}

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// Serve the static front-end (index.html, app.js, style.css) from /public.
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/fm-track", fmTrack);
app.use("/api/cargotrack", cargoTrack);

app.listen(PORT, () => {
  console.log(`INTEGRATION DEMO running at http://localhost:${PORT}`);
});
