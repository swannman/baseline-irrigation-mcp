/**
 * Minimal HTTPS request helper built on node:https.
 *
 * Why not global fetch/undici? Baseline's server emits a multi-line
 * Content-Security-Policy header (raw newlines), which undici's strict HTTP parser
 * rejects with HPE_INVALID_HEADER_TOKEN. node:https with `insecureHTTPParser: true`
 * tolerates the malformed header the same way browsers do. We only relax HTTP header
 * parsing — TLS verification stays on.
 */
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
  setCookies: string[];
  headers: Record<string, string | string[] | undefined>;
}

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export function httpRequest(
  urlStr: string,
  opts: HttpRequestOptions = {},
): Promise<HttpResponse> {
  const url = new URL(urlStr);
  const { method = "GET", headers = {}, body, timeoutMs = 30000 } = opts;

  return new Promise<HttpResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          ...(body != null ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
        // Tolerate Baseline's malformed multi-line CSP header (browsers do too).
        insecureHTTPParser: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const raw = res.headers["set-cookie"];
          resolve({
            status,
            ok: status >= 200 && status < 300,
            body: Buffer.concat(chunks).toString("utf8"),
            setCookies: Array.isArray(raw) ? raw : raw ? [raw] : [],
            headers: res.headers,
          });
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        Object.assign(new Error(`Request to ${url.pathname} timed out`), {
          name: "AbortError",
        }),
      );
    });

    if (body != null) req.write(body);
    req.end();
  });
}
