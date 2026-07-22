# fm-track live tracking demo

A minimal example integration of the two **fm-track** APIs, rendered on an
OpenStreetMap map:

1. **Object API** — fetch the list of vehicles (`object_id` + name).
2. **Object Coordinates Streaming API** — subscribe (SSE) to live positions and
   plot / move a marker for each vehicle in real time.

This is an example implementation for a client, kept intentionally small.

## Architecture

```
Browser (Leaflet + OSM)  ──►  Express backend  ──►  api.fm-track.com
   /api/objects   (JSON)         proxies + holds the api_key
   /api/stream    (SSE)
```

The browser talks only to a small local backend, which proxies the fm-track API.
Two reasons this backend exists instead of calling fm-track straight from the
browser:

- **CORS** — `api.fm-track.com` does not return the headers a browser needs to
  read a cross-origin response, so a direct front-end call is blocked.
- **Security** — the `api_key` stays on the server and is never shipped to the
  browser.

## Run it

Requires Node.js **20.12+** (uses the built-in `fetch` and `process.loadEnvFile()`).

**1. Install dependencies**

```bash
cd fm-track-demo
npm install
```

**2. Set your API key**

The key is read only from the environment — it is never hard-coded, so it can't
leak into version control (`.env` is git-ignored). Copy the template and fill it in:

```bash
cp .env.example .env
# then edit .env and set:  FM_TRACK_API_KEY=your-key
```

Alternatively, provide it as a real environment variable instead of a `.env` file:

- PowerShell: `$env:FM_TRACK_API_KEY = "your-key"`
- bash: `export FM_TRACK_API_KEY=your-key`

If `FM_TRACK_API_KEY` is missing, the server exits with a clear message.

**3. Start the server**

```bash
npm start
```

Then open <http://localhost:3000>.

### Configuration

Set these in `.env` or as real environment variables:

| Variable            | Required | Default                     | Notes                          |
| ------------------- | -------- | --------------------------- | ------------------------------ |
| `FM_TRACK_API_KEY`  | yes      | —                           | Your fm-track API key.         |
| `FM_TRACK_BASE_URL` | no       | `https://api.fm-track.com`  | Upstream API base URL.         |
| `PORT`              | no       | `3000`                      | e.g. `PORT=8090` for port 8090.|

To run on a different port:

- PowerShell: `$env:PORT = "8090"; npm start`
- bash: `PORT=8090 npm start`

### Using it

Vehicles appear in the left sidebar and as markers on the map. **Click a vehicle**
(in the list or its marker) to open a popup showing the full last coordinate
record, when it was received (local time), the position date, and the data
latency (`Delay`).

## Notes on the data (per the fm-track docs)

- **De-duplication** — on every (re)connect the stream first re-sends the last
  known coordinate, so the same record can arrive twice. The client de-dupes on
  `object_id` + `datetime`.
- **Data is "as is"** — the API does not guarantee chronological order and does
  not clean the data; ordering/filtering is the client's responsibility.
- **`0 / 0` coordinates** mean the device has no GPS fix yet — these are shown as
  "no GPS fix" in the list and are not placed on the map.

## Files

| File               | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `server.js`        | Express proxy for the Object API and the SSE stream |
| `public/index.html`| Page shell (Leaflet + sidebar + map)                |
| `public/app.js`    | Fetch objects, subscribe to the stream, draw markers|
| `public/style.css` | Layout / styling                                    |
