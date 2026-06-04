/**
 * Shaping helpers — turn the verbose Baseline payloads into compact summaries that
 * are useful to an LLM/agent without flooding context. All inputs are treated loosely
 * (the upstream shapes are large and partially undocumented); we read defensively.
 */
import {
  decodeKeyValues,
  describeDeviceType,
  describeStatusCode,
  parseAlarmId,
  decodeProgramTimestamp,
  DEVICE_COLLECTION_META,
} from "./codes.js";
import type { HistorySeries } from "./client.js";

type Any = Record<string, any>;

const DEVICE_COLLECTIONS = [
  ["zones", "zone"],
  ["flowMeters", "flow meter"],
  ["moistureSensors", "moisture sensor"],
  ["temperatureSensors", "temperature sensor"],
  ["pressureSensors", "pressure sensor"],
  ["masterValves", "master valve"],
  ["pumps", "pump"],
  ["rainGauges", "rain gauge"],
  ["eventSwitches", "event switch"],
] as const;

/** Summarize GET /companys/{id} into sites -> controllers with counts. */
export function summarizeTopology(company: Any) {
  const sites = (company?.sites ?? []).map((site: Any) => ({
    id: site.id,
    name: site.name,
    controllers: (site.controllers ?? []).map((c: Any) => ({
      id: c.id,
      name: c.name,
      serialNumber: c.serialNumber,
      mac: c.macaddress,
      model: modelFromType(c.type),
      firmware: c.version,
      connectionType: c.connectionType,
      timeZone: c.timeZone?.name,
      subscription: c.subscription
        ? { active: c.subscription.active, expires: c.subscription.date }
        : undefined,
      counts: deviceCounts(c),
    })),
  }));
  return {
    company: { id: company?.id, name: company?.name },
    sites,
  };
}

function deviceCounts(c: Any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key] of DEVICE_COLLECTIONS) {
    const arr = c?.[key];
    // zones can appear as a mix of ids and objects; just count length
    if (Array.isArray(arr) && arr.length) counts[key] = arr.length;
  }
  return counts;
}

function modelFromType(type: unknown): string {
  // observed: type "32" => BaseStation 3200 (BL-3200)
  if (String(type) === "32") return "BaseStation 3200";
  return type == null ? "Unknown" : `type ${type}`;
}

function summarizeStatusBlock(status: Any | undefined) {
  if (!status) return undefined;
  return {
    code: status.statusCode,
    text: status.statusText ?? describeStatusCode(status.statusCode),
    lastUpdated: status.lastUpdatedTimestamp,
    values: decodeKeyValues(status.statusKeyValues),
  };
}

/** Summarize GET /controllers/{id}/status — live controller + zone + device snapshot. */
export function summarizeStatus(status: Any) {
  const zones = (status?.zones ?? []).map((z: Any) => ({
    zoneNumber: z.zoneNumber,
    name: z.name,
    decoderSN: z.decoderSN,
    designedFlow: z.designedFlow,
    status: summarizeStatusBlock(z.status),
  }));

  const devices: Record<string, any[]> = {};
  for (const [key, label] of DEVICE_COLLECTIONS) {
    if (key === "zones") continue;
    const arr = status?.[key];
    if (Array.isArray(arr) && arr.length) {
      devices[key] = arr.map((d: Any) => ({
        type: label,
        name: d.name,
        serialNumber: d.serialNumber,
        deviceNumber: d.deviceNumber,
        status: summarizeStatusBlock(d.status),
      }));
    }
  }

  return {
    controllerId: status?.id,
    mac: status?.macaddress,
    controllerStatus: summarizeStatusBlock(status?.status),
    zoneCount: zones.length,
    zones,
    devices,
  };
}

/** Summarize GET /controllers/{id}/zones — zone configuration. */
export function summarizeZones(zones: Any[]) {
  return (zones ?? []).map((z: Any) => ({
    id: z.id,
    zoneNumber: z.zoneNumber,
    name: z.name,
    decoderSN: z.decoderSN,
    enabled: z.enabled,
    designedFlow: z.designedFlow,
    learnedFlow: z.learnedFlow,
    hydrozone: z.hydrozone
      ? {
          plantType: z.hydrozone.plantType,
          sprinklerType: z.hydrozone.sprinklerType,
          applicationRate: z.hydrozone.applicationRate,
          rootDepth: z.hydrozone.rootDepth,
          cropCoefficient: z.hydrozone.cropCoefficient,
        }
      : undefined,
  }));
}

/**
 * The status key that carries the "primary" live reading for each device type,
 * with a human label/unit. Used to surface one obvious number per object.
 */
const PRIMARY_READING: Record<string, { key: string; label: string; unit: string }> = {
  "pressure sensor": { key: "VR", label: "pressure", unit: "PSI" },
  "moisture sensor": { key: "VP", label: "moisture", unit: "%VWC" },
  "temperature sensor": { key: "VT", label: "temperature", unit: "°" },
};

/**
 * Locate one enumerated device in GET /controllers/{id}/status by its reporting serial
 * (serialNumber for sensors/meters/valves/pumps, decoderSN for zones) and return its live
 * status: decoded status code, all key/value readings, and a best-guess primary reading.
 * Flow-meter water usage comes from a separate /realtimestatus call (see the tool).
 */
export function findLiveDevice(status: Any, sn: string) {
  for (const { key, label } of DEVICE_COLLECTION_META) {
    const arr = status?.[key];
    if (!Array.isArray(arr)) continue;
    const d = arr.find(
      (x: Any) => x && typeof x === "object" && (x.serialNumber === sn || x.decoderSN === sn),
    );
    if (!d) continue;
    const readings = decodeKeyValues(d.status?.statusKeyValues);
    const pr = PRIMARY_READING[label];
    const prKv = pr ? (d.status?.statusKeyValues ?? []).find((k: Any) => k.key === pr.key) : undefined;
    return {
      found: true as const,
      type: label,
      collection: key,
      id: d.id,
      number: d.zoneNumber ?? d.deviceNumber,
      name: d.name,
      serialNumber: d.serialNumber ?? d.decoderSN,
      statusCode: d.status?.statusCode,
      statusText: d.status?.statusText ?? describeStatusCode(d.status?.statusCode),
      lastUpdated: d.status?.lastUpdatedTimestamp,
      primary: prKv ? { label: pr!.label, value: Number(prKv.value), unit: pr!.unit } : undefined,
      readings,
    };
  }
  return { found: false as const };
}

/** Shape a flow meter's /realtimestatus response. */
export function summarizeFlowRealtime(meter: Any) {
  const rt = meter?.realTimeStatus ?? {};
  return {
    id: meter?.id,
    name: meter?.name,
    serialNumber: meter?.serialNumber,
    deviceNumber: meter?.deviceNumber,
    enabled: meter?.enabled,
    kValue: meter?.k_value,
    waterUsage: rt.waterUsage,
    waterUsageMax: rt.waterUsageMax,
  };
}

/** Decode GET /messages?ids= alarm/fault list. */
export function summarizeAlarms(messages: Any[]) {
  return (messages ?? []).map((m: Any) => {
    const parsed = parseAlarmId(m.alarmID);
    return {
      id: m.id,
      controllerId: m.controllerID,
      alarmId: m.alarmID,
      cleared: m.cleared,
      priority: m.priority,
      received: m.receivedDate,
      senderType: m.senderType,
      senderTypeLabel: describeDeviceType(m.senderType),
      senderId: m.senderId,
      fault: parsed.suffixLabel ?? parsed.suffix,
      text: typeof m.text === "string" ? m.text.replace(/\r\n/g, " ").trim() : m.text,
    };
  });
}

/**
 * Enumerate every device on GET /controllers/{id}, grouped by type, exposing the
 * `reportingSn` to use as `device-sn` in baseline_get_history. Zones use decoderSN;
 * other devices use serialNumber.
 */
export function summarizeDevices(controller: Any, zones: Any[]) {
  const groups: Record<string, any[]> = {};
  const shape = (d: Any, label: string, snField: string) => ({
    type: label,
    id: d.id,
    number: d.zoneNumber ?? d.deviceNumber,
    name: d.name,
    serialNumber: d.serialNumber,
    decoderSN: d.decoderSN,
    reportingSn: d[snField],
    enabled: d.enabled,
    designedFlow: d.designedFlow,
    units: d.units,
  });

  for (const { key, label, snField } of DEVICE_COLLECTION_META) {
    if (key === "zones") {
      // zones come from the dedicated /zones endpoint (full objects with decoderSN);
      // the topology's zones[] is a mix of ids and objects.
      if (Array.isArray(zones) && zones.length) {
        groups.zones = zones.map((z: Any) => shape(z, label, snField));
      }
      continue;
    }
    const arr = controller?.[key];
    if (!Array.isArray(arr) || !arr.length) continue;
    const objs = arr.filter((d: Any) => d && typeof d === "object");
    if (objs.length) groups[key] = objs.map((d: Any) => shape(d, label, snField));
  }

  const counts = Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [k, v.length]),
  );
  return { controllerId: controller?.id, mac: controller?.macaddress, counts, devices: groups };
}

/**
 * Parse programs + their last/next-run statistics from the legacy getXML config tree
 * (fast-xml-parser output of getXML.php?what=<mac>). This is the only source of program
 * run history. LS/LF = last start/finish, NS/NF = next, LD = last duration (s),
 * LU = last water used.
 */
export function summarizePrograms(configTree: any) {
  const controller = configTree?.baseline?.company?.controllers?.controller;
  const c = Array.isArray(controller) ? controller[0] : controller;
  let progs = c?.programs?.program;
  if (!progs) return [];
  if (!Array.isArray(progs)) progs = [progs];

  const ext = (es: Any, key: string): string | undefined => {
    const node = es?.[key];
    if (node == null) return undefined;
    return node["@_value"] ?? (typeof node === "object" ? undefined : String(node));
  };

  return progs.map((p: Any) => {
    const es = p.extendedstatus ?? {};
    let zones = p.zones?.zone ?? [];
    if (!Array.isArray(zones)) zones = [zones];
    const lastDur = ext(es, "LD");
    return {
      number: Number(p["@_id"] ?? p.id),
      description: typeof p.description === "string" ? p.description : "",
      status: typeof p.status === "string" ? p.status : p.status?.["#text"],
      lastStart: decodeProgramTimestamp(ext(es, "LS")),
      lastFinish: decodeProgramTimestamp(ext(es, "LF")),
      lastDurationSeconds: lastDur ? Number(lastDur) : undefined,
      lastWaterUsed: ext(es, "LU") ? Number(ext(es, "LU")) : undefined,
      nextStart: decodeProgramTimestamp(ext(es, "NS")),
      nextFinish: decodeProgramTimestamp(ext(es, "NF")),
      zones: zones.map((z: Any) => ({
        number: Number(z["@_id"] ?? z.id),
        decoderSN: z.serialnumber,
        runtimeSeconds: z.runtime != null ? Number(z.runtime) : undefined,
      })),
    };
  });
}

/** Compact a modern reporting series: keep stats and trim points to relevant fields. */
export function summarizeHistory(series: HistorySeries) {
  const fieldForKind: Record<string, keyof (typeof series.data)[number]> = {
    pressure: "pressure",
    moisture: "moistureValue",
    temperature: "temperatureValue",
    flow: "flowValue",
    zone: "runTimeMinutes",
  };
  const primary = series.kind ? fieldForKind[series.kind] : undefined;
  return {
    kind: series.kind,
    deviceSn: series.deviceSn,
    granularity: series.granularity,
    stats: {
      max: series.max,
      min: series.min,
      average: series.average,
      median: series.median,
    },
    pointCount: series.data?.length ?? 0,
    points: (series.data ?? []).map((p) => ({
      date: p.date,
      value: primary ? (p[primary] as number | undefined) : undefined,
      ...(p.runState ? { runState: p.runState } : {}),
      ...(p.runTimeMinutes ? { runTimeMinutes: p.runTimeMinutes } : {}),
    })),
  };
}

/** Strip HTML from a proactive-notification message to a short plain-text line. */
export function summarizeAnnouncements(items: Any[]) {
  return (items ?? []).map((n: Any) => ({
    id: n.id,
    active: n.active ?? n.isActive,
    posted: n.postedDate,
    message:
      typeof n.message === "string"
        ? n.message
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : n.message,
  }));
}
