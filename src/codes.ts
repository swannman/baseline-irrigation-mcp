/**
 * Lookup tables for the short codes Baseline returns in status / alarm payloads.
 *
 * These were reverse-engineered by observing the live API (see research/API-REFERENCE.md);
 * they are best-effort, not vendor-documented. Decoders always fall back to the raw code so
 * an unknown value is surfaced rather than dropped.
 */

/** `statusCode` on a device/zone/controller status block. */
export const STATUS_CODES: Record<string, string> = {
  OK: "Okay",
  DN: "Done",
  RN: "Running",
  OF: "Off",
  ER: "Error",
  WT: "Waiting",
  WA: "Waiting",
  SK: "Soaking",
  PS: "Paused",
  PA: "Paused",
  SC: "Short Circuit",
  NR: "No Response",
  DR: "Rain Delay",
  LO: "Learning",
  UN: "Unknown",
};

/** Keys seen inside `statusKeyValues`. Meanings inferred from context — treat as hints. */
export const STATUS_KEYS: Record<string, string> = {
  NU: "Device number",
  VA: "Current draw (amps)",
  VV: "Voltage (V)",
  VT: "Board/device temperature",
  VD: "Dielectric / raw moisture reading",
  VP: "Volumetric water content (%)",
  VR: "Reading (PSI for pressure, GPM for flow)",
  VG: "Flow (gph)",
  FS: "Flow status",
};

/** `senderType` on an alarm/message, and device-type codes used throughout the API. */
export const DEVICE_TYPES: Record<string, string> = {
  DV: "Controller/Device",
  ZN: "Zone",
  FM: "Flow Meter",
  MS: "Moisture Sensor",
  MV: "Master Valve",
  PM: "Pump",
  RG: "Rain Gauge",
  TS: "Temperature Sensor",
  WS: "Water Source",
  PC: "Point of Control",
  ML: "Mainline",
  AN: "Analog Device",
  DS: "Decoder",
};

/** Trailing token of an `alarmID` (e.g. the `SC` in `023_ZN_23_SC`). */
export const ALARM_SUFFIXES: Record<string, string> = {
  SC: "Short Circuit",
  NR: "No Response",
  OF: "Turned Off",
  OC: "Open Circuit",
  HF: "High Flow",
  LF: "Low Flow",
  NF: "No Flow",
  UF: "Unscheduled Flow",
  EM: "Empty Condition",
  CF: "Communication Failure",
  LB: "Low Battery",
};

export function describeStatusCode(code: string | undefined): string {
  if (!code) return "Unknown";
  return STATUS_CODES[code] ?? code;
}

export function describeDeviceType(code: string | undefined): string {
  if (!code) return "Unknown";
  return DEVICE_TYPES[code] ?? code;
}

/** Decode a statusKeyValues array into labelled entries while keeping the raw key. */
export function decodeKeyValues(
  kvs: Array<{ key: string; value: string }> | undefined,
): Array<{ key: string; label: string; value: string }> {
  if (!Array.isArray(kvs)) return [];
  return kvs.map((kv) => ({
    key: kv.key,
    label: STATUS_KEYS[kv.key] ?? kv.key,
    value: kv.value,
  }));
}

/** Parse `023_ZN_23_SC` -> structured pieces. */
export function parseAlarmId(alarmId: string | undefined): {
  code?: string;
  senderType?: string;
  senderTypeLabel?: string;
  senderId?: string;
  suffix?: string;
  suffixLabel?: string;
} {
  if (!alarmId) return {};
  const parts = alarmId.split("_");
  if (parts.length < 4) return { code: alarmId };
  const [code, senderType, senderId, suffix] = [
    parts[0],
    parts[1],
    parts.slice(2, -1).join("_"),
    parts[parts.length - 1],
  ];
  return {
    code,
    senderType,
    senderTypeLabel: DEVICE_TYPES[senderType] ?? senderType,
    senderId,
    suffix,
    suffixLabel: ALARM_SUFFIXES[suffix] ?? suffix,
  };
}

/** The report `type` values accepted by getData.php. */
export const REPORT_TYPES = [
  "WaterUsage",
  "ZoneRuntimes",
  "ZonesActivity",
  "ControllerActivity",
  "MoistureLevels",
  "Temperature",
  "FlowMeterTotals",
  "RainfallAccumulation",
  "MeasuredFlow",
  "ExpectedFlow",
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/** Metric kinds for the modern /baseservice2/reporting API. */
export const HISTORY_KINDS = [
  "pressure",
  "zone",
  "flow",
  "moisture",
  "temperature",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** Granularities accepted by the reporting API's `granularity` param. */
export const GRANULARITIES = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** Device collections on GET /controllers/{id}, with the singular label and id-field. */
export const DEVICE_COLLECTION_META: Array<{
  key: string;
  label: string;
  /** the field whose value is the reporting `device-sn` */
  snField: "serialNumber" | "decoderSN";
}> = [
  { key: "zones", label: "zone", snField: "decoderSN" },
  { key: "flowMeters", label: "flow meter", snField: "serialNumber" },
  { key: "moistureSensors", label: "moisture sensor", snField: "serialNumber" },
  { key: "temperatureSensors", label: "temperature sensor", snField: "serialNumber" },
  { key: "pressureSensors", label: "pressure sensor", snField: "serialNumber" },
  { key: "masterValves", label: "master valve", snField: "serialNumber" },
  { key: "pumps", label: "pump", snField: "serialNumber" },
  { key: "rainGauges", label: "rain gauge", snField: "serialNumber" },
  { key: "eventSwitches", label: "event switch", snField: "serialNumber" },
];

/**
 * Decode the YYMMDDHHMMSS timestamps used in a program's <extendedstatus>
 * (e.g. LS/LF/NS/NF). Returns ISO-ish "20YY-MM-DD HH:MM:SS" or null when blank.
 */
export function decodeProgramTimestamp(v: string | undefined): string | null {
  if (!v || v.length < 12) return null;
  const yy = v.slice(0, 2),
    mm = v.slice(2, 4),
    dd = v.slice(4, 6),
    hh = v.slice(6, 8),
    mi = v.slice(8, 10),
    ss = v.slice(10, 12);
  return `20${yy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}
