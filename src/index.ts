#!/usr/bin/env node
/**
 * baseline-mcp — Model Context Protocol server for the Baseline / BaseManager
 * irrigation controller system (https://baselineapps.net).
 *
 * Read + alerts + reporting only. No write/control endpoints are exposed.
 * Credentials come from BASELINE_USERNAME / BASELINE_PASSWORD env vars.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BaselineClient, BaselineHttpError, type Identity } from "./client.js";
import { Catalog } from "./catalog.js";
import { REPORT_TYPES, HISTORY_KINDS, GRANULARITIES } from "./codes.js";
import {
  summarizeAlarms,
  summarizeAnnouncements,
  summarizeDevices,
  summarizeFlowRealtime,
  summarizeHistory,
  summarizePrograms,
  summarizeStatus,
  summarizeTopology,
  summarizeZones,
  findLiveDevice,
} from "./format.js";

// ---- config ------------------------------------------------------------------

const username = process.env.BASELINE_USERNAME;
const password = process.env.BASELINE_PASSWORD;
if (!username || !password) {
  console.error(
    "[baseline-mcp] Missing credentials. Set BASELINE_USERNAME and BASELINE_PASSWORD.",
  );
  process.exit(1);
}

const client = new BaselineClient({
  baseUrl: process.env.BASELINE_BASE_URL ?? "https://baselineapps.net",
  username,
  password,
  timeoutMs: Number(process.env.BASELINE_TIMEOUT_MS ?? 30000),
});

/** Optional numeric env override; warns and ignores a non-numeric value. */
function numericEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`[baseline-mcp] Ignoring non-numeric ${name}="${raw}".`);
    return undefined;
  }
  return n;
}

// Accounts may span multiple orgs/controllers; these pin a default scope.
const catalog = new Catalog(client, {
  scopeCompanyId: numericEnv("BASELINE_COMPANY_ID"),
  defaultControllerId: numericEnv("BASELINE_CONTROLLER_ID"),
});

// ---- small caches so tools can default sensibly -----------------------------

let identityCache: Identity | null = null;

async function getIdentity(): Promise<Identity> {
  if (!identityCache) identityCache = await client.whoami();
  return identityCache;
}

const resolveControllerId = (given?: number) => catalog.resolveControllerId(given);
const resolveMac = (controllerId: number) => catalog.resolveMac(controllerId);

// ---- server ------------------------------------------------------------------

const server = new McpServer({ name: "baseline-mcp", version: "0.1.0" });

/** Wrap a handler so upstream errors become clean MCP error results. */
function tool(
  result: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return result()
    .then((data) => ({
      content: [{ type: "text" as const, text: json(data) }],
    }))
    .catch((err) => {
      const msg =
        err instanceof BaselineHttpError
          ? `${err.message}${err.body ? `\n${err.body}` : ""}`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    });
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

const controllerIdArg = z
  .number()
  .int()
  .optional()
  .describe(
    "Controller id (from baseline_list_controllers). Optional when the account has exactly " +
      "one accessible controller or BASELINE_CONTROLLER_ID is set; otherwise required.",
  );

server.registerTool(
  "baseline_whoami",
  {
    title: "Who am I",
    description:
      "Validate the session and return the logged-in user, access level, current company, and assigned controller ids.",
    inputSchema: {},
  },
  () => tool(() => getIdentity()),
);

server.registerTool(
  "baseline_list_companies",
  {
    title: "List organizations",
    description:
      "List the Baseline organizations (companies) this account can access. Use a companyId to scope baseline_list_controllers, or pin one via BASELINE_COMPANY_ID.",
    inputSchema: {},
  },
  () =>
    tool(async () => {
      const companies = await catalog.listCompanies();
      return { count: companies.length, companies };
    }),
);

server.registerTool(
  "baseline_list_controllers",
  {
    title: "List controllers",
    description:
      "List sites and controllers (with model, firmware, subscription, device counts) across every organization the account can access. Pass companyId to limit to one org.",
    inputSchema: {
      companyId: z
        .number()
        .int()
        .optional()
        .describe("Limit to a single organization (from baseline_list_companies)."),
    },
  },
  ({ companyId }) =>
    tool(async () => {
      const companies = companyId != null
        ? [{ id: companyId, name: "" }]
        : await catalog.listCompanies();
      const orgs = [];
      for (const co of companies) {
        const tree = await catalog.getCompanyTree(co.id);
        const topo = summarizeTopology(tree as Record<string, any>);
        for (const site of topo.sites)
          for (const c of site.controllers) catalog.noteMac(c.id, c.mac);
        orgs.push(topo);
      }
      return { organizationCount: orgs.length, organizations: orgs };
    }),
);

server.registerTool(
  "baseline_get_status",
  {
    title: "Get live controller status",
    description:
      "Live snapshot for a controller: overall status plus per-zone and per-device status codes (Running/Done/Off/Error/etc.) with decoded sensor readings.",
    inputSchema: { controllerId: controllerIdArg },
  },
  ({ controllerId }) =>
    tool(async () => {
      const cid = await resolveControllerId(controllerId);
      const status = await client.getJson(
        `/baseservice2/controllers/${cid}/status`,
      );
      const s = status as { macaddress?: string };
      catalog.noteMac(cid, s.macaddress);
      return summarizeStatus(status as Record<string, any>);
    }),
);

server.registerTool(
  "baseline_list_zones",
  {
    title: "List zones",
    description:
      "Zone configuration for a controller: number, name, decoder serial, enabled state, designed/learned flow, and hydrozone agronomy details.",
    inputSchema: { controllerId: controllerIdArg },
  },
  ({ controllerId }) =>
    tool(async () => {
      const cid = await resolveControllerId(controllerId);
      const zones = await client.getJson<any[]>(
        `/baseservice2/controllers/${cid}/zones`,
      );
      return summarizeZones(zones);
    }),
);

server.registerTool(
  "baseline_get_alarms",
  {
    title: "Get alarms / faults",
    description:
      "Active alarms and faults for a controller (valve short circuits, flow comm failures, dial-off, empty conditions, etc.), decoded with sender device and fault type.",
    inputSchema: {
      controllerId: controllerIdArg,
      includeCleared: z
        .boolean()
        .optional()
        .describe("Include already-cleared alarms (default false)."),
    },
  },
  ({ controllerId, includeCleared }) =>
    tool(async () => {
      const cid = await resolveControllerId(controllerId);
      const q = includeCleared ? "&showCleared=true" : "";
      const messages = await client.getJson<any[]>(
        `/baseservice2/messages?ids=${cid}${q}`,
      );
      const alarms = summarizeAlarms(messages);
      return {
        controllerId: cid,
        activeCount: alarms.filter((a) => !a.cleared).length,
        alarms,
      };
    }),
);

server.registerTool(
  "baseline_get_announcements",
  {
    title: "Get system announcements",
    description:
      "Vendor proactive notifications (e.g. scheduled server-maintenance banners), as plain text.",
    inputSchema: {},
  },
  () =>
    tool(async () => {
      const items = await client.getJson<any[]>(
        "/baseservice2/proactiveNotifications",
      );
      return summarizeAnnouncements(items);
    }),
);

server.registerTool(
  "baseline_get_report",
  {
    title: "Get time-series report",
    description:
      "Fetch a reporting time-series for a controller. Returns aligned timestamp/value points. " +
      "Types: " +
      REPORT_TYPES.join(", ") +
      ". Dates are 'YYYY-MM-DD HH:mm'. Use id to scope to a single zone/device, omit for controller-wide.",
    inputSchema: {
      type: z
        .enum(REPORT_TYPES as unknown as [string, ...string[]])
        .describe("Report type."),
      start: z.string().describe("Start datetime, 'YYYY-MM-DD HH:mm'."),
      end: z.string().describe("End datetime, 'YYYY-MM-DD HH:mm'."),
      controllerId: controllerIdArg,
      resolution: z
        .enum(["daily", "hourly"])
        .optional()
        .describe("Bucket size (default daily)."),
      id: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Zone/device id to scope the report; omit for controller-wide."),
    },
  },
  ({ type, start, end, controllerId, resolution, id }) =>
    tool(async () => {
      const cid = await resolveControllerId(controllerId);
      const mac = await resolveMac(cid);
      return client.getReport({
        type: type as (typeof REPORT_TYPES)[number],
        mac,
        start,
        end,
        resolution,
        id: id ?? null,
      });
    }),
);

server.registerTool(
  "baseline_list_devices",
  {
    title: "List all devices",
    description:
      "Enumerate every device on a controller grouped by type (zones, flow meters, moisture/temperature/pressure sensors, master valves, pumps, rain gauges, event switches). Each entry includes the `reportingSn` to pass as deviceSn to baseline_get_history.",
    inputSchema: { controllerId: controllerIdArg },
  },
  ({ controllerId }) =>
    tool(async () => {
      const cid = await resolveControllerId(controllerId);
      // Topology controller carries full device objects (serials); /zones carries full zones.
      const [controller, zones] = await Promise.all([
        catalog.controllerObject(cid),
        client.getJson<any[]>(`/baseservice2/controllers/${cid}/zones`),
      ]);
      catalog.noteMac(cid, controller.macaddress);
      return summarizeDevices(controller, zones);
    }),
);

server.registerTool(
  "baseline_get_programs",
  {
    title: "List programs & run stats",
    description:
      "List watering programs for a controller with their last start/finish, duration, water used, next scheduled start/finish, and assigned zones. Sourced from the controller config.",
    inputSchema: { controllerId: controllerIdArg },
  },
  ({ controllerId }) =>
    tool(async () => {
      const cid = await resolveControllerId(controllerId);
      const mac = await resolveMac(cid);
      const config = await client.getControllerConfigXml(mac);
      return { controllerId: cid, mac, programs: summarizePrograms(config) };
    }),
);

server.registerTool(
  "baseline_get_live",
  {
    title: "Get live reading for a device",
    description:
      "Current live reading for one enumerated device, by its reporting serial (from baseline_list_devices: serialNumber, or decoderSN for a zone). " +
      "Returns the decoded status and key/value readings, plus a primary value where meaningful: pressure sensor → PSI, moisture sensor → %VWC, " +
      "flow meter → real-time water usage, zones/valves/pumps → run state. Pair with baseline_get_history for the same device's trend.",
    inputSchema: {
      deviceSn: z
        .string()
        .describe("Device reporting serial (serialNumber, or decoderSN for a zone)."),
      controllerId: controllerIdArg,
    },
  },
  ({ deviceSn, controllerId }) =>
    tool(async () => {
      const cid = await resolveControllerId(controllerId);
      const status = await client.getJson(`/baseservice2/controllers/${cid}/status`);
      const s = status as { macaddress?: string };
      catalog.noteMac(cid, s.macaddress);
      const live = findLiveDevice(status as Record<string, any>, deviceSn);
      if (!live.found) {
        throw new Error(
          `No device with serial "${deviceSn}" on controller ${cid}. Use baseline_list_devices.`,
        );
      }
      // Flow meters expose live water usage via a dedicated endpoint.
      if (live.collection === "flowMeters" && live.id != null) {
        const rt = await client.getFlowMeterRealtime(live.id);
        return { ...live, realtime: summarizeFlowRealtime(rt as Record<string, any>) };
      }
      return live;
    }),
);

server.registerTool(
  "baseline_get_history",
  {
    title: "Get historical metric series",
    description:
      "Modern reporting time-series for a single device. Kinds: " +
      HISTORY_KINDS.join(", ") +
      ". This is the source for historical PRESSURE and for per-zone/flow/moisture/temperature trends. " +
      "deviceSn is the device's reporting serial (from baseline_list_devices: serialNumber for sensors/meters, decoderSN for zones). " +
      "Dates accept ISO-8601 or YYYY-MM-DD. Returns max/min/average/median plus per-bucket points.",
    inputSchema: {
      kind: z.enum(HISTORY_KINDS as unknown as [string, ...string[]]).describe("Metric kind."),
      deviceSn: z
        .string()
        .describe("Device reporting serial (serialNumber, or decoderSN for a zone)."),
      from: z.string().describe("Start date (ISO-8601 or YYYY-MM-DD)."),
      to: z.string().describe("End date (ISO-8601 or YYYY-MM-DD)."),
      controllerId: controllerIdArg,
      granularity: z
        .enum(GRANULARITIES as unknown as [string, ...string[]])
        .optional()
        .describe("Bucket size (default day)."),
    },
  },
  ({ kind, deviceSn, from, to, controllerId, granularity }) =>
    tool(async () => {
      const cid = await resolveControllerId(controllerId);
      const mac = await resolveMac(cid);
      const series = await client.getHistory({
        kind: kind as (typeof HISTORY_KINDS)[number],
        mac,
        deviceSn,
        from,
        to,
        granularity: granularity as (typeof GRANULARITIES)[number] | undefined,
      });
      return summarizeHistory(series);
    }),
);

// ---- boot --------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[baseline-mcp] ready (stdio)");
}

main().catch((err) => {
  console.error("[baseline-mcp] fatal:", err);
  process.exit(1);
});
