# baseline-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Baseline / BaseManager**
irrigation controller system at [baselineapps.net](https://baselineapps.net).

**Scope: read-only.** Status, alarms, and reporting. No watering/control or schedule-edit
endpoints are exposed.

## Tools

| Tool | What it returns |
|------|-----------------|
| `baseline_whoami` | Logged-in user, access level, company, assigned controller ids. |
| `baseline_list_companies` | Organizations this account can access (for multi-org accounts). |
| `baseline_list_controllers` | Sites and controllers across all accessible organizations, with model, firmware, subscription, and device counts. |
| `baseline_get_status` | Live snapshot: controller + per-zone + per-device status codes and decoded sensor readings. |
| `baseline_list_zones` | Zone config: number, name, decoder, enabled, designed/learned flow, hydrozone agronomy. |
| `baseline_get_alarms` | Active alarms/faults, decoded (sender device + fault type). `includeCleared` to show resolved. |
| `baseline_get_announcements` | Vendor maintenance banners as plain text. |
| `baseline_list_devices` | Enumerate all devices by type (zones, flow meters, sensors, valves, pumps…), each with the `reportingSn` used for live/history. |
| `baseline_get_programs` | Watering programs with last/next start & finish, duration, water used, and assigned zones. |
| `baseline_get_live` | Current live reading for one device by serial — pressure (PSI), flow (water usage), moisture (%VWC), zone/valve/pump run state. |
| `baseline_get_history` | Modern reporting time-series for one device — **historical pressure**, moisture, temperature, flow, or zone runtime — with max/min/avg/median + points. |
| `baseline_get_report` | Legacy time-series report (water usage, runtimes, moisture, flow) as timestamp/value points. |

### Core model: enumerate → live or history

The intended workflow is **enumerate objects, then ask for live or historical data on one**:

1. `baseline_list_devices` (or `baseline_get_programs`) → each object carries a `reportingSn`.
2. `baseline_get_live` `{ deviceSn }` → its current reading.
3. `baseline_get_history` `{ kind, deviceSn, from, to, granularity }` → its trend.

`deviceSn` is the same key for both: a sensor/meter `serialNumber`, or a zone `decoderSN`.
`baseline_get_history` uses the newer Analytics reporting API (`/baseservice2/reporting/…`)
and is the **only** source for historical **pressure**. `baseline_get_report` is the older
getData.php path, kept for water-usage/runtime aggregates.

### Accounts, organizations & controllers

A controller is the primary key for every data tool; organizations (companies) are a grouping.
Some accounts can access **multiple organizations and controllers**. Tools that take a
`controllerId` resolve it in this order:

1. the explicit `controllerId` argument, else
2. the `BASELINE_CONTROLLER_ID` env default, else
3. the sole accessible controller (when there's exactly one).

If several controllers are accessible and none is specified, the tool returns the list so you
can pick one. `baseline_list_companies` → `baseline_list_controllers` enumerates everything.
Set `BASELINE_COMPANY_ID` to restrict enumeration to one organization, and/or
`BASELINE_CONTROLLER_ID` to pin a default controller.

### Report types

`baseline_get_report` accepts: `WaterUsage`, `ZoneRuntimes`, `ZonesActivity`,
`ControllerActivity`, `MoistureLevels`, `Temperature`, `FlowMeterTotals`,
`RainfallAccumulation`, `MeasuredFlow`, `ExpectedFlow`. Dates are `YYYY-MM-DD HH:mm`;
`resolution` is `daily` or `hourly`; pass `id` to scope to a single zone/device.

## Setup

```bash
npm install      # also builds via the prepare hook
npm run build    # or build explicitly
```

Provide credentials via environment variables (`BASELINE_USERNAME`, `BASELINE_PASSWORD`).
The server logs in lazily, caches the `SID` session cookie, and re-authenticates on expiry.

### Register with an MCP client

Claude Code / Claude Desktop (`claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "baseline": {
      "command": "node",
      "args": ["/absolute/path/to/baseline-mcp/dist/index.js"],
      "env": {
        "BASELINE_USERNAME": "your-username",
        "BASELINE_PASSWORD": "your-password"
      }
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add baseline \
  -e BASELINE_USERNAME=your-username \
  -e BASELINE_PASSWORD=your-password \
  -- node /absolute/path/to/baseline-mcp/dist/index.js
```

## Verify

```bash
# Exercise the HTTP client against the live API (read-only):
BASELINE_USERNAME=... BASELINE_PASSWORD=... npm run smoke

# Exercise the MCP protocol layer (spawns the server, lists + calls tools):
BASELINE_USERNAME=... BASELINE_PASSWORD=... npm run mcp-check
```

## Notes & caveats

- **Lenient HTTP parsing.** Baseline returns a malformed multi-line `Content-Security-Policy`
  header that Node's default `fetch`/undici parser rejects. The client uses `node:https` with
  `insecureHTTPParser: true` to tolerate it (browsers do the same). TLS verification stays on.
- **Inferred codes.** Status-key meanings (`VA`, `VP`, `VR`, …) and alarm suffixes were
  inferred from observed data, not vendor docs. Decoders always include the raw code, and
  `statusText` is passed through verbatim. See [`src/codes.ts`](src/codes.ts).
- **Endpoints are unofficial** and may change without notice.

## Project layout

```
src/
  index.ts    MCP server + tool definitions
  client.ts   BaselineClient: session lifecycle, JSON + report fetches
  http.ts     node:https transport (lenient parser)
  format.ts   payload-shaping helpers
  codes.ts    status / alarm / device code decode tables
scripts/
  smoke.ts    live API smoke test
  mcp-check.ts  MCP protocol smoke test
research/
  API-REFERENCE.md   API observations
```
