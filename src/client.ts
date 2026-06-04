/**
 * BaselineClient — thin authenticated HTTP client for baselineapps.net.
 *
 * Handles the SID-cookie session lifecycle (lazy login, auto re-login on 401) and
 * exposes typed helpers for the JSON REST API (/baseservice2) and the legacy XML
 * reporting endpoint (/app/php/getData.php).
 */
import { XMLParser } from "fast-xml-parser";
import {
  REPORT_TYPES,
  HISTORY_KINDS,
  type ReportType,
  type HistoryKind,
  type Granularity,
} from "./codes.js";
import { httpRequest, type HttpResponse } from "./http.js";

export interface BaselineConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface Identity {
  loggedIn: boolean;
  accessLevel?: number;
  accessLevelDescription?: string;
  currentCompany?: { id: number; name: string; link: string };
  user?: {
    id: number;
    username: string;
    accessLevelDescription: string;
    assignedControllers: number[];
  };
}

export interface ReportSeries {
  type: string;
  controllerMac: string;
  start: string;
  end: string;
  resolution: string;
  points: Array<{ timestamp: string; value: number | null }>;
}

export interface HistoryPoint {
  date: string;
  pressure?: number;
  moistureValue?: number;
  temperatureValue?: number;
  flowValue?: number;
  runTimeMinutes?: number;
  runState?: string;
  state?: boolean;
  zoneNumber?: string;
  [k: string]: unknown;
}

export interface HistorySeries {
  kind?: string;
  deviceSn?: string;
  granularity?: string;
  max?: number;
  min?: number;
  average?: number;
  median?: number;
  data: HistoryPoint[];
}

/** Error carrying the HTTP status so callers/tools can react (e.g. surface 404 vs 500). */
export class BaselineHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "BaselineHttpError";
  }
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export class BaselineClient {
  private sid: string | null = null;
  private loginInFlight: Promise<void> | null = null;

  constructor(private readonly cfg: BaselineConfig) {}

  // ---- session ---------------------------------------------------------------

  /** POST credentials, capture the SID cookie. Throws on bad credentials. */
  private async login(): Promise<void> {
    const res = await this.raw("/baseservice2/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.cfg.username,
        password: this.cfg.password,
      }),
    });
    if (!res.ok) {
      throw new BaselineHttpError(
        `Login failed (HTTP ${res.status}). Check BASELINE_USERNAME / BASELINE_PASSWORD.`,
        res.status,
        res.body,
      );
    }
    const sid = extractSid(res.setCookies);
    if (!sid) {
      throw new BaselineHttpError(
        "Login succeeded but no SID cookie was returned.",
        res.status,
        res.body,
      );
    }
    this.sid = sid;
  }

  /** Ensure exactly one login runs even under concurrent calls. */
  private async ensureSession(): Promise<void> {
    if (this.sid) return;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = null;
      });
    }
    await this.loginInFlight;
  }

  /** Validate the current session and return the caller's identity (logs in if needed). */
  async whoami(): Promise<Identity> {
    return this.getJson<Identity>("/baseservice2/login");
  }

  // ---- requests --------------------------------------------------------------

  /** Low-level request with timeout; does not touch the session. */
  private async raw(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<HttpResponse> {
    const url = path.startsWith("http") ? path : this.cfg.baseUrl + path;
    return httpRequest(url, {
      method: init.method,
      body: init.body,
      timeoutMs: this.cfg.timeoutMs,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "baseline-mcp/0.1",
        ...(this.sid ? { Cookie: `SID=${this.sid}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  /** Authenticated request with one transparent re-login on an expired session. */
  private async authed(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<HttpResponse> {
    await this.ensureSession();
    let res = await this.raw(path, init);
    if (isSessionExpired(res)) {
      this.sid = null;
      await this.ensureSession();
      res = await this.raw(path, init);
    }
    return res;
  }

  /** GET + parse JSON, raising BaselineHttpError on non-2xx. */
  async getJson<T = unknown>(path: string): Promise<T> {
    const res = await this.authed(path, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new BaselineHttpError(
        `GET ${path} -> HTTP ${res.status}`,
        res.status,
        res.body.slice(0, 500),
      );
    }
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new BaselineHttpError(
        `GET ${path} returned non-JSON body`,
        res.status,
        res.body.slice(0, 500),
      );
    }
  }

  // ---- reporting -------------------------------------------------------------

  /**
   * Fetch a time-series report from the legacy getData.php endpoint and parse the
   * XML into aligned timestamp/value points.
   */
  async getReport(opts: {
    type: ReportType;
    mac: string;
    start: string; // "YYYY-MM-DD HH:mm"
    end: string;
    resolution?: "daily" | "hourly";
    id?: string | number | null;
  }): Promise<ReportSeries> {
    if (!REPORT_TYPES.includes(opts.type)) {
      throw new Error(
        `Unknown report type "${opts.type}". Valid: ${REPORT_TYPES.join(", ")}`,
      );
    }
    const resolution = opts.resolution ?? "daily";
    const params = new URLSearchParams({
      id: opts.id == null ? "null" : String(opts.id),
      start: opts.start,
      end: opts.end,
      type: opts.type,
      resolution,
      mac: opts.mac,
    });
    const res = await this.authed(`/app/php/getData.php?${params.toString()}`, {
      headers: { Accept: "application/xml, text/xml, */*" },
    });
    if (!res.ok) {
      const hint = /invalid\s+id/i.test(res.body)
        ? ` — the "${opts.type}" report likely requires a specific zone/device "id".`
        : "";
      throw new BaselineHttpError(
        `getData.php -> HTTP ${res.status}${hint}`,
        res.status,
        res.body.slice(0, 500),
      );
    }
    return parseReportXml(res.body, opts.type, opts.mac, opts.start, opts.end, resolution);
  }

  /**
   * Modern reporting time-series (the Analytics app's API). Returns aggregate
   * stats plus per-bucket data points. This is the source for historical PRESSURE
   * (and zone/flow/moisture/temperature), which the legacy getData.php does not serve.
   */
  async getHistory(opts: {
    kind: HistoryKind;
    mac: string;
    deviceSn: string;
    from: string; // ISO-8601 or "YYYY-MM-DD"
    to: string;
    granularity?: Granularity;
  }): Promise<HistorySeries> {
    if (!HISTORY_KINDS.includes(opts.kind)) {
      throw new Error(
        `Unknown history kind "${opts.kind}". Valid: ${HISTORY_KINDS.join(", ")}`,
      );
    }
    const granularity = opts.granularity ?? "day";
    const dateRange = `${toIso(opts.from)},${toIso(opts.to)}`;
    const params = new URLSearchParams({
      "device-sn": opts.deviceSn,
      "date-range": dateRange,
      granularity,
    });
    const raw = await this.getJson<HistorySeries>(
      `/baseservice2/reporting/${opts.kind}/controller/${opts.mac}?${params.toString()}`,
    );
    return { ...raw, kind: opts.kind, deviceSn: opts.deviceSn, granularity };
  }

  /** Real-time flow-meter status (waterUsage). */
  async getFlowMeterRealtime(flowMeterId: number): Promise<unknown> {
    return this.getJson(`/baseservice2/flowmeters/${flowMeterId}/realtimestatus`);
  }

  /**
   * Fetch + parse the legacy controller config XML (getXML.php?what=<mac>), which is
   * the only place programs and their last/next-run statistics are exposed.
   */
  async getControllerConfigXml(mac: string): Promise<unknown> {
    const res = await this.authed(
      `/app/php/getXML.php?what=${encodeURIComponent(mac)}`,
      { headers: { Accept: "application/xml, text/xml, */*" } },
    );
    if (!res.ok) {
      throw new BaselineHttpError(
        `getXML.php -> HTTP ${res.status}`,
        res.status,
        res.body.slice(0, 500),
      );
    }
    return xml.parse(res.body);
  }
}

// ---- helpers -----------------------------------------------------------------

/**
 * The legacy getData.php endpoint signals an expired session with a 302 redirect to a
 * "please login" page rather than a 401. The JSON API uses 401. Treat both as expiry.
 * Note: getData.php also returns this same 302 for an invalid `id`, so we only retry once
 * (in authed()); a persistent failure is surfaced to the caller.
 */
function isSessionExpired(res: HttpResponse): boolean {
  if (res.status === 401) return true;
  if (
    (res.status === 302 || res.status === 303) &&
    /please\s+login/i.test(res.body)
  )
    return true;
  return false;
}

/**
 * Normalize a date input to the ISO-8601 UTC form the reporting API expects.
 * Accepts a full ISO string, or "YYYY-MM-DD" (treated as midnight UTC).
 */
function toIso(input: string): string {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date "${input}" (use ISO-8601 or YYYY-MM-DD).`);
  }
  return d.toISOString();
}

function extractSid(setCookies: string[]): string | null {
  for (const c of setCookies) {
    const m = /(?:^|;|,)\s*SID=([^;,\s]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

function parseReportXml(
  body: string,
  type: string,
  mac: string,
  start: string,
  end: string,
  resolution: string,
): ReportSeries {
  const doc = xml.parse(body) as {
    baseline?: { graphdata?: { graph?: unknown } };
  };
  const graphNode = doc?.baseline?.graphdata?.graph;
  const graph = Array.isArray(graphNode) ? graphNode[0] : graphNode;
  const g = (graph ?? {}) as {
    ydata?: string | number;
    labels?: { "#text"?: string } | string;
  };

  const rawY = g.ydata == null ? "" : String(g.ydata);
  const labelsField = g.labels;
  const rawLabels =
    typeof labelsField === "object" && labelsField !== null
      ? String((labelsField as { "#text"?: string })["#text"] ?? "")
      : String(labelsField ?? "");

  const values = rawY === "" ? [] : rawY.split(",").map(toNum);
  const labels = rawLabels === "" ? [] : rawLabels.split(",");

  const points = labels.map((timestamp, i) => ({
    timestamp: timestamp.trim(),
    value: i < values.length ? values[i] : null,
  }));

  return { type, controllerMac: mac, start, end, resolution, points };
}

function toNum(s: string): number | null {
  const t = s.trim();
  if (t === "" || t.toLowerCase() === "na" || t.toLowerCase() === "null") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
