# INTEGRATION DEMO

A small, working example of how to integrate two vehicle tracking APIs and show
the vehicles live on an OpenStreetMap map. Use it as a reference: run it with
your own credentials, then copy the parts you need.

| API            | What the demo uses                                                        | How positions arrive        |
| -------------- | ------------------------------------------------------------------------- | --------------------------- |
| **fm-track**   | Object API + Object Coordinates Streaming API                             | Live push (Server-Sent Events) |
| **CargoTrack** | `atlas` (devices + positions) or `ddata` (position), see [docs][ct-docs]  | Polling every 30 s          |

You choose the API in the app, type in its credentials and click **Connect**.

[ct-docs]: https://api.cargotrack.ro/docs

## Run it

Requires Node.js **20.12+** (uses the built-in `fetch` and `process.loadEnvFile()`).

```bash
cd fm-track-demo
npm install
npm start
```

Open <http://localhost:3000>, then in the left sidebar:

1. choose the **API**:
   - **ATLAS-API**: CargoTrack `atlas` endpoints, enter **Username** + **Password**
   - **DDATA-API**: CargoTrack `ddata` endpoint, same **Username** + **Password**
     (shared with ATLAS-API; both give the same positions, see below)
   - **FM-TRACK-API**: fm-track, enter your **API key**
2. click **Connect**.

Vehicles appear in the sidebar and as markers on the map. **Click a vehicle**
(in the list or its marker) to see the full raw record from the API, when it
was received (local time) and the position date.

The status badge under the title shows what is happening: `streaming live` /
`updated hh:mm:ss`, `reconnecting…`, or a red error such as `invalid API key`
or `invalid username or password`.

The credentials are remembered in your browser's `localStorage` so you don't
have to retype them. That is a convenience for a local demo only. Don't store
passwords like that in a production app.

### Configuration (optional)

Credentials are normally entered in the app. Everything below is optional and
can be set in a `.env` file (copy `.env.example`) or as environment variables.

| Variable              | Default                     | Notes                                               |
| --------------------- | --------------------------- | --------------------------------------------------- |
| `FM_TRACK_API_KEY`    | —                           | Used only if no API key is entered in the app.      |
| `CARGOTRACK_USERNAME` | —                           | Used only if no username/password is entered.       |
| `CARGOTRACK_PASSWORD` | —                           | Used only if no username/password is entered.       |
| `FM_TRACK_BASE_URL`   | `https://api.fm-track.com`  | Upstream API base URL.                              |
| `CARGOTRACK_BASE_URL` | `https://api.cargotrack.ro` | Upstream API base URL.                              |
| `PORT`                | `3000`                      | e.g. `PORT=8090` for port 8090.                     |

To run on a different port:

- PowerShell: `$env:PORT = "8090"; npm start`
- bash: `PORT=8090 npm start`

## How it works

```
Browser (Leaflet + OSM)          Express backend (server.js)          Tracking APIs
                                 providers/fm-track.js
  /api/fm-track/objects   ──►      adds api_key                 ──►  api.fm-track.com
  /api/fm-track/stream    (SSE)    pipes the event stream
                                 providers/cargotrack.js
  /api/cargotrack/devices    ──►   adds username + password     ──►  api.cargotrack.ro
  /api/cargotrack/positions        (atlas or ddata)
```

The browser talks only to a small local backend, which forwards each request to
the real API:

- **CORS**: `api.fm-track.com` does not return the headers a browser needs to
  read a cross-origin response, so a direct front-end call is blocked.
- **Credentials**: the browser sends the key or password only to this local
  server. The server adds it to the upstream call, so it never appears in a
  third-party URL or in the browser history.

Each API is self-contained in two files, one on the server side and one in the
browser (ATLAS-API and DDATA-API share the CargoTrack files). If you integrate
only one API, those two files are all you need to read:

| API        | Server (proxy)             | Browser (client + data mapping)  |
| ---------- | -------------------------- | -------------------------------- |
| fm-track   | `providers/fm-track.js`    | `public/providers/fm-track.js`   |
| CargoTrack | `providers/cargotrack.js`  | `public/providers/cargotrack.js` |

Each browser module converts the API's records into one common shape, which
the shared map code (`public/app.js`) draws:

```js
{ id, name?, lat, lng, speed?, ignition?, time /* Date */, raw /* original record */ }
```

## fm-track notes

> **IP whitelist required.** fm-track only answers requests from whitelisted IP
> addresses. Because the calls are made by `server.js`, it is the **public IP of
> the machine running the server** that has to be whitelisted. Contact CargoTrack
> (office@cargotrack.ro) to have it added. Until then the app shows
> `API not reachable` with this hint. A wrong key shows `invalid API key` instead.

Flow (as recommended by the fm-track docs):

1. `GET /objects` gives the list of vehicles (`object_id` and `name`).
2. `GET /object-coordinates-stream` opens one long-lived SSE connection. Each
   message is one coordinate record. The browser's `EventSource` reconnects on
   its own if the connection drops.

- **De-duplication**: on every (re)connect the stream first re-sends the last
  known coordinate, so the same record can arrive twice. The client de-dupes on
  `object_id` + `datetime`.
- **Data is "as is"**: the API does not guarantee chronological order and does
  not clean the data. Ordering and filtering are the client's job.
- **`0 / 0` coordinates** mean the device has no GPS fix yet. These are shown
  as "no GPS fix" in the list and are not placed on the map.

## CargoTrack notes

There is no streaming endpoint, so the client polls the latest positions every
30 seconds. Both endpoints return the latest position per device. In the app
they are two separate entries, **ATLAS-API** and **DDATA-API**:

**`atlas`**: `GET /atlas/{username}/devices?password=…` once for the names,
then `GET /atlas/{username}/positions?password=…` on every poll.

```json
{ "deviceList": [ { "deviceId": "869153044171459", "deviceName": "BH78BNC" } ] }

{ "positionList": [ {
    "deviceId": "869153044171459",
    "coordinate": { "latitude": 50.5698616, "longitude": 8.4861333 },
    "heading": 283, "speed": 0, "ignitionState": "ON",
    "dateTime": { "year": 2026, "month": 10, "day": 9, "hour": 6,
                  "minute": 14, "seconds": 33, "timezone": "UTC" } } ] }
```

**`ddata`**: `POST /ddata/1.0/position` with `{ "username": …, "password": … }`
as the JSON body. One call returns the name and position of each device, plus
the raw device IO values (`io…` fields).

```json
[ { "name": "BH78BNC", "imei": "869153044171459",
    "datetime": "2026-10-09 06:14:33",
    "latitude": 50.5698616, "longitude": 8.4861333,
    "altitude": 163, "course": 283, "speed": 0, "sat": 16,
    "io…": "…" } ]
```

- **IDs**: `ddata.imei` is the same value as `atlas.deviceId`.
- **Time zone**: all times are UTC. `atlas` gives them as an object, `ddata` as
  a `"YYYY-MM-DD HH:MM:SS"` string without a zone marker.
- **Rate limit**: 10 requests per minute (`X-RateLimit-Limit`). Over the limit
  you get `429`. The demo polls every 30 s and keeps going after a `429`.
- **Errors**: `400` missing parameters, `403` wrong credentials, `422`
  unexpected error, `429` too many requests.

## Files

| File                             | Purpose                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `server.js`                      | Express server: static files + mounts the two proxies    |
| `providers/fm-track.js`          | fm-track proxy: Object API + SSE stream                  |
| `providers/cargotrack.js`        | CargoTrack proxy: atlas devices/positions, ddata position |
| `public/index.html`              | Page shell (Leaflet + sidebar + map)                     |
| `public/app.js`                  | Shared map, sidebar, popup and connection form           |
| `public/providers/fm-track.js`   | fm-track client: objects + EventSource, record mapping   |
| `public/providers/cargotrack.js` | CargoTrack client: polling, record mapping               |
| `public/style.css`               | Layout / styling                                         |
