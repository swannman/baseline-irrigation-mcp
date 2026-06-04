# Baseline / BaseManager Web API

Notes from observing https://baselineapps.net (BaseManager / AppManager / Analytics SPA)
against a live Operator account.

Identifiers below are placeholders: `{companyId}`, `{controllerId}`, `{MAC}`, `<serial>`.

## Hosts / base paths

| Base | Format | Used for |
|------|--------|----------|
| `https://baselineapps.net/baseservice2/` | JSON | Modern REST API — auth, topology, live status, alarms, programs, reporting |
| `https://baselineapps.net/baseservice/`  | XML  | Legacy — custom map markers (not used here) |
| `https://baselineapps.net/app/php/getXML.php` | XML | Legacy config dump (`what=ALL` / `what=<MAC>`) |
| `https://baselineapps.net/app/php/getData.php` | XML | Legacy reporting time-series (graphs) |

## Authentication

Two-step in the UI, but the API call is a single POST:

```
POST /baseservice2/login
Content-Type: application/json
X-Requested-With: XMLHttpRequest
{"username":"<user>","password":"<pass>"}
```

Response sets the session cookie:

```
Set-Cookie: SID=<uuid>; Path=/; Secure; HttpOnly
```

All subsequent requests (both `/baseservice2/*` and `/app/php/*`) authenticate with
`Cookie: SID=<uuid>`. Send `X-Requested-With: XMLHttpRequest` on every call.

> Note: the server emits a multi-line `Content-Security-Policy` header that Node's strict
> HTTP parser rejects (`HPE_INVALID_HEADER_TOKEN`). Use a lenient parser (this client uses
> `node:https` with `insecureHTTPParser: true`); browsers tolerate it too.

**Session check / identity** — `GET /baseservice2/login` returns:
```json
{ "loggedIn": true, "accessLevel": 0,
  "currentCompany": { "id": {companyId}, "name": "<company>", "link": "companys/{companyId}" },
  "user": { "id": <userId>, "username": "<user>", "accessLevelDescription": "Operator",
            "assignedControllers": [ {controllerId} ] } }
```
A 401 here (or `loggedIn:false`) means the SID expired → re-POST login.

**Logout** — `PUT /baseservice2/logout`.

## Topology (config)

`GET /baseservice2/companys/{companyId}` → full tree:

```
company → sites[] → controllers[] → {
   id, type, serialNumber, macaddress, name, connectionType, version,
   timeZone, city, state,
   mainlines[]      (mainlineNumber, name, zones[])
   pointOfControls[]/waterSources[]/emptyConditions[]
   zones[]          (id, zoneNumber, name, decoderSN, designedFlow)
   flowMeters[] masterValves[] moistureSensors[] temperatureSensors[]
   pressureSensors[] pumps[] rainGauges[] eventSwitches[]
   subscription { date, active, type, warrantyEndDate }
}
```
A `type` of `"32"` corresponds to a BaseStation 3200 (BL-3200). Each controller's device
arrays here carry full objects with `serialNumber` — the preferred enumeration source.

Other config endpoints: `/baseservice2/controllers/{id}`, `/zones/{id}`,
`/mainlines/{id}`, `/companys`, `/users/userlist/?companyId=`, `/timezones`,
`/countrys`, `/apps`.

## Live status

`GET /baseservice2/controllers/{id}/status` → live snapshot:

```
{ id, macaddress,
  status: { lastUpdatedTimestamp, statusCode, statusText, statusKeyValues[] },
  zones[]:          { id, zoneNumber, name, decoderSN, designedFlow, status{...} },
  flowMeters[] moistureSensors[] masterValves[] pumps[] pressureSensors[]
  mainlines[] pointOfControls[] waterSources[] temperatureSensors[]
  rainGauges[] eventSwitches[] devices[] }
```

Each `status` block:
```json
{ "lastUpdatedTimestamp": "<iso8601>",
  "statusCode": "OK", "statusText": "Okay",
  "statusKeyValues": [ {"key":"VA","value":"0.02"}, ... ] }
```

### Status codes (`statusCode` / `statusText`) observed
`OK`=Okay · `DN`=Done · `RN`=Running · `OF`=Off · `ER`=Error
(others exist: waiting/soaking/paused — surfaced verbatim via `statusText`).

### statusKeyValues keys observed
| key | meaning (inferred from context) |
|-----|--------------------------------|
| `NU` | device number |
| `VA` | current draw, amps |
| `VV` | volts |
| `VT` | board/device temperature |
| `VD` | dielectric / raw moisture reading |
| `VP` | volumetric water content % (moisture sensor) |
| `VR` | reading — PSI (pressure), GPM (flow) |
| `VG` | flow gph / NA |
| `FS` | flow status |
Surface both decoded label and raw key/value (meanings are inferred, not official).

## Alarms / messages

`GET /baseservice2/messages?ids={controllerId}` → active fault list:

```json
[ { "id": <id>, "controllerType":"32", "controllerID": {controllerId},
    "senderType":"FM", "senderId":"<serial>",
    "receivedDate":"<iso8601>",
    "text":"...Two-wire Communication Failure...",
    "priority":2, "alarmID":"220_FM_<serial>_NR", "cleared":false } ]
```

- `ids` accepts a single id or CSV of controller ids.
- `&showCleared=true` to include cleared alarms.
- `senderType`: `DV`=device/controller · `ZN`=zone · `FM`=flow meter ·
  `MS`=moisture · `MV`=master valve · `PM`=pump · `RG`=rain gauge ·
  `TS`=temp sensor · `WS`=water source.
- `alarmID` = `{code}_{senderType}_{senderId}_{suffix}`
  (e.g. `0NN_ZN_NN_SC` = zone Short Circuit; `_NR` = No Response; `_OF` = Off).
- `priority`: lower-level integer; surfaced verbatim.

## System announcements

`GET /baseservice2/proactiveNotifications` → vendor maintenance banners
(`message` is HTML, `colorCode`, `postedDate`, `active`).

## Reporting time-series (legacy getData.php)

`GET /app/php/getData.php` — params (from `getGraphData(type,start,end,id,resolution,mac)`):

| param | example | notes |
|-------|---------|-------|
| `type` | `WaterUsage` | see report types below |
| `start` | `YYYY-MM-DD HH:mm` | URL-encoded |
| `end`   | `YYYY-MM-DD HH:mm` | |
| `resolution` | `daily` | `daily` / `hourly` |
| `mac` | `{MAC}` | controller MAC |
| `id` | `null` | device/zone id, or `null` for controller-wide |

Response XML:
```xml
<baseline><meta>...</meta><graphdata>
  <graph type="MeasuredFlow">
    <ydata>0.0,0.0,...</ydata>
    <labels type="MeasuredFlow">2026-05-21 00:00:00,...</labels>
  </graph>
</graphdata></baseline>
```

`ZonesActivity` is special: instead of `<ydata>`/`<labels>` it emits
`<zoneevent>{zoneNumber},{iso-timestamp},{statusCode}</zoneevent>` rows (a per-zone event
stream — e.g. `DN`=Done completions, `UA`=idle hourly poll).

### Report `type` values (from JS bundle)
`WaterUsage` · `ZoneRuntimes` · `ZonesActivity` · `ControllerActivity` ·
`MoistureLevels` · `Temperature` · `FlowMeterTotals` · `RainfallAccumulation` ·
`MeasuredFlow` · `ExpectedFlow`
(`ZoneRuntimes`/`ZonesActivity` are keyed by zone **number** as `id`.)

## Modern reporting API (the "Analytics" app) — historical metrics

The newer **Analytics** app (an in-place view in app-manager, `view=ReportsView`) does
NOT use getData.php. It uses a dedicated JSON reporting service. **This is the source for
historical pressure** (and zone/flow/moisture/temperature trends) — getData.php returns
empty for pressure.

```
GET /baseservice2/reporting/{kind}/controller/{MAC}
    ?device-sn=<serial>
    &date-range={ISO_start},{ISO_end}     # two ISO-8601 UTC stamps, comma-joined
    &granularity={minute|hour|day|week|month|year}
```

- `{kind}`: `pressure` · `zone` · `flow` · `moisture` · `temperature`
  (`zones`/`program`/`waterusage`/etc. → 404).
- `device-sn`: the device's serial — `serialNumber` for sensors/meters, or a zone's
  `decoderSN`. Zone number does NOT work here.
- Response: `{ max, min, average, median, data[] }` (the `zone` kind omits max/min/median).
  Each `data[]` point:
  ```json
  { "date":"<iso8601>", "pressure":0, "moistureValue":0,
    "temperatureValue":0, "flowValue":0, "runTimeMinutes":0, "runState":"DN",
    "state":false, "zoneNumber":"0", "twoWireVoltage":0, "solenoidCurrent":0, ... }
  ```
  The relevant field per kind: pressure→`pressure`, moisture→`moistureValue`,
  temperature→`temperatureValue`, flow→`flowValue`, zone→`runTimeMinutes`(+`runState`).

Example shape: `GET /baseservice2/reporting/pressure/controller/{MAC}?device-sn=<serial>&date-range=<ISO>,<ISO>&granularity=month`.

## Real-time device values

- **Pressure / analog live value**: `GET /controllers/{id}/status` → `pressureSensors[].status`
  → `statusKeyValues` `VR` (PSI). (`/analogdevices/{id}` returns config only — units + range;
  `/analogdevices/{id}/realtimestatus` is 404.)
- **Flow meter live usage**: `GET /baseservice2/flowmeters/{id}/realtimestatus`
  → `{ realTimeStatus: { waterUsage, waterUsageMax } }`.
- **Everything else (zones, valves, pumps, sensors) live**: `GET /controllers/{id}/status`.

## Enumerating devices & programs

- **All non-zone devices** (flow meters, moisture/temperature/pressure sensors, master
  valves, pumps, rain gauges, event switches): `GET /baseservice2/companys/{companyId}`
  → `sites[].controllers[]` — each carries full device arrays with `serialNumber`.
  (`GET /controllers/{id}` returns some collections as bare ids, so prefer the topology.)
- **Zones** (with `decoderSN`, the reporting serial): `GET /controllers/{id}/zones`.
- **Programs** (+ last/next-run stats): parse `getXML.php?what={MAC}` →
  `baseline.company.controllers.controller.programs.program[]`. Each `<program>`:
  - `@id`, `<description>`, `<status>`, `<zones><zone @id><serialnumber><runtime>…`
  - `<extendedstatus>`: `LS`=last start, `LF`=last finish, `LD`=last duration (s),
    `LU`=last water used (gal), `NS`/`NF`/`ND`/`NU`=next start/finish/duration/usage.
    Timestamps are `YYMMDDHHMMSS` (e.g. `260602000100` → 2026-06-02 00:01:00).
  - `GET /baseservice2/programs` is 405 (GET not allowed); the config XML is the practical source.

## Device type codes (used in alarms / status / config)
`AN` analog · `ZN` zone · `MS` moisture sensor · `MV` master valve ·
`PM` pump · `FM` flow meter · `RG` rain gauge · `TS` temperature sensor ·
`WS` water source · `PC` point of control · `ML` mainline · `DV` device/controller.
