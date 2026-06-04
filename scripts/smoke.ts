/**
 * Live smoke test — exercises the BaselineClient against the real API.
 * Requires BASELINE_USERNAME / BASELINE_PASSWORD in the environment.
 *
 *   BASELINE_USERNAME=... BASELINE_PASSWORD=... npm run smoke
 *
 * Read-only: only GETs and the login POST are issued.
 */
import { BaselineClient } from "../src/client.js";
import {
  summarizeAlarms,
  summarizeStatus,
  summarizeTopology,
} from "../src/format.js";

const username = process.env.BASELINE_USERNAME;
const password = process.env.BASELINE_PASSWORD;
if (!username || !password) {
  console.error("Set BASELINE_USERNAME and BASELINE_PASSWORD.");
  process.exit(1);
}

const client = new BaselineClient({
  baseUrl: process.env.BASELINE_BASE_URL ?? "https://baselineapps.net",
  username,
  password,
  timeoutMs: 30000,
});

function ok(label: string, detail: unknown) {
  console.log(`✓ ${label}:`, detail);
}

async function main() {
  const me = await client.whoami();
  ok("whoami", {
    user: me.user?.username,
    access: me.user?.accessLevelDescription,
    company: me.currentCompany?.name,
    controllers: me.user?.assignedControllers,
  });

  const companyId = me.currentCompany!.id;
  const company = await client.getJson(`/baseservice2/companys/${companyId}`);
  const topo = summarizeTopology(company as any);
  const controllers = topo.sites.flatMap((s) => s.controllers);
  ok(
    "topology",
    controllers.map((c) => `${c.name} (id ${c.id}, mac ${c.mac})`),
  );

  const cid = me.user!.assignedControllers[0];
  const mac = controllers.find((c) => c.id === cid)?.mac ?? controllers[0].mac;

  const status = await client.getJson(
    `/baseservice2/controllers/${cid}/status`,
  );
  const s = summarizeStatus(status as any);
  ok("status", {
    controller: s.controllerStatus,
    zoneCount: s.zoneCount,
    sampleZone: s.zones[0],
  });

  const messages = await client.getJson<any[]>(
    `/baseservice2/messages?ids=${cid}`,
  );
  const alarms = summarizeAlarms(messages);
  ok(
    "alarms",
    alarms.map((a) => `[p${a.priority}] ${a.senderTypeLabel} ${a.senderId}: ${a.fault}`),
  );

  const today = "2026-06-03 23:00";
  const report = await client.getReport({
    type: "MeasuredFlow",
    mac: mac!,
    start: "2026-05-28 00:00",
    end: today,
    resolution: "daily",
  });
  ok("report MeasuredFlow", {
    points: report.points.length,
    first: report.points[0],
    last: report.points[report.points.length - 1],
  });

  console.log("\nAll smoke checks passed.");
}

main().catch((err) => {
  console.error("✗ smoke failed:", err);
  process.exit(1);
});
