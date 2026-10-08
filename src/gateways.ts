import type { Env } from "./env";
import { logEvent } from "./db";

/** The 25 supported gateways. The slug is the last part of the webhook URL: /hooks/gateway/<slug> */
export const GATEWAYS: Record<string, { name: string; family: string }> = {
  kong: { name: "Kong Gateway", family: "Open-source" },
  apisix: { name: "Apache APISIX", family: "Open-source" },
  tyk: { name: "Tyk", family: "Open-source" },
  krakend: { name: "KrakenD", family: "Open-source" },
  traefik: { name: "Traefik", family: "Open-source" },
  envoy: { name: "Envoy Proxy", family: "Open-source" },
  ocelot: { name: "Ocelot", family: "Open-source" },
  "express-gateway": { name: "Express Gateway", family: "Open-source" },
  zuul: { name: "Zuul", family: "Open-source" },
  apiman: { name: "Apiman", family: "Open-source" },
  "aws-api-gateway": { name: "Amazon API Gateway", family: "Cloud" },
  "azure-apim": { name: "Azure API Management", family: "Cloud" },
  "gcp-api-gateway": { name: "GCP API Gateway", family: "Cloud" },
  apigee: { name: "Google Apigee", family: "Cloud" },
  "oracle-api-gateway": { name: "Oracle API Gateway", family: "Cloud" },
  zuplo: { name: "Zuplo", family: "Cloud" },
  mulesoft: { name: "MuleSoft Anypoint", family: "Enterprise" },
  wso2: { name: "WSO2 API Platform", family: "Enterprise" },
  "ibm-api-connect": { name: "IBM API Connect", family: "Enterprise" },
  boomi: { name: "Boomi", family: "Enterprise" },
  layer7: { name: "Layer7", family: "Enterprise" },
  "3scale": { name: "Red Hat 3scale", family: "Enterprise" },
  gravitee: { name: "Gravitee", family: "Event-driven" },
  axway: { name: "Axway Amplify Fusion", family: "Event-driven" },
  kgateway: { name: "Kgateway / Gloo", family: "Event-driven" },
};

/** One request (or a pre-counted group of requests) in the meter's standard shape. */
export interface GwRecord {
  api: string;
  method: string;
  path: string;
  status: number;
  consumer: string;
  latencyMs: number | null;
  bytes: number;
  ts: number;
  count: number;
}

/* ---------------- decoding ---------------- */

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}
const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
function b64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function bytesToText(b: Uint8Array): Promise<string> {
  return new TextDecoder().decode(isGzip(b) ? await gunzip(b) : b);
}

/** Parse a body that may be JSON, a JSON array, NDJSON, or plain access-log lines. */
function parseText(text: string): unknown[] {
  const t = text.trim();
  if (!t) return [];
  if (t[0] === "{" || t[0] === "[") {
    try {
      return [JSON.parse(t)];
    } catch {
      /* fall through to lines (NDJSON) */
    }
  }
  return t.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const s = l.trim();
    if (s[0] === "{") {
      try {
        return JSON.parse(s);
      } catch {
        /* not JSON */
      }
    }
    return s; // text line
  });
}

interface Ctx {
  records: GwRecord[];
  firehoseRequestId?: string;
  depth: number;
}

/** Walk any supported envelope down to individual log records. */
async function unwrap(v: unknown, ctx: Ctx, depth = 0): Promise<void> {
  if (depth > 8 || v == null) return;
  if (typeof v === "string") {
    const r = parseLine(v);
    if (r) ctx.records.push(r);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) await unwrap(x, ctx, depth + 1);
    return;
  }
  if (typeof v !== "object") return;
  const o = v as Record<string, any>;

  // Amazon Data Firehose HTTP endpoint delivery
  if (typeof o.requestId === "string" && Array.isArray(o.records) && o.records.every((r: any) => typeof r?.data === "string")) {
    ctx.firehoseRequestId = o.requestId;
    for (const r of o.records) {
      try {
        for (const x of parseText(await bytesToText(b64(r.data)))) await unwrap(x, ctx, depth + 1);
      } catch {
        /* skip unreadable record */
      }
    }
    return;
  }
  // CloudWatch Logs subscription payload
  if (o.messageType === "CONTROL_MESSAGE") return;
  if (o.messageType === "DATA_MESSAGE" && Array.isArray(o.logEvents)) {
    for (const e of o.logEvents) for (const x of parseText(String(e.message ?? ""))) await unwrap(x, ctx, depth + 1);
    return;
  }
  // Google Pub/Sub push
  if (o.message && typeof o.message.data === "string" && o.subscription !== undefined) {
    try {
      for (const x of parseText(await bytesToText(b64(o.message.data)))) await unwrap(x, ctx, depth + 1);
    } catch {
      /* skip */
    }
    return;
  }
  // Google Cloud LogEntry: request details live in httpRequest or jsonPayload
  if (o.httpRequest || (o.jsonPayload && o.logName)) {
    const merged = { ...(o.jsonPayload ?? {}), ...(o.httpRequest ?? {}), timestamp: o.timestamp };
    const r = normalize(merged);
    if (r) ctx.records.push(r);
    else if (o.textPayload) await unwrap(String(o.textPayload), ctx, depth + 1);
    return;
  }
  // Common batch wrappers from log shippers and OCI
  for (const k of ["records", "logs", "events", "entries", "logEntries", "items", "data"]) {
    if (Array.isArray(o[k]) && o[k].length && !looksLikeRequest(o)) {
      for (const x of o[k]) await unwrap(x, ctx, depth + 1);
      return;
    }
  }
  // OCI log entry: request fields under data
  if (o.data && typeof o.data === "object" && !Array.isArray(o.data) && !looksLikeRequest(o) && looksLikeRequest(o.data)) {
    const r = normalize({ ...o.data, time: o.time ?? o.data.time });
    if (r) ctx.records.push(r);
    return;
  }
  // Fluent Bit / Vector often wrap the raw line as "log" or "message"
  if (!looksLikeRequest(o)) {
    const inner = o.log ?? o.message ?? o.msg;
    if (typeof inner === "string") return unwrap(inner.trim()[0] === "{" ? safeJson(inner) ?? inner : inner, ctx, depth + 1);
  }
  const r = normalize(o);
  if (r) ctx.records.push(r);
}

function safeJson(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* ---------------- normalizing ---------------- */

function flatten(o: unknown, prefix = "", out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (depth > 6 || o == null || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = (prefix ? prefix + "." : "") + k.toLowerCase();
    if (v != null && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out, depth + 1);
    else if (!Array.isArray(v)) out.set(key, v);
  }
  return out;
}

/** Find the first candidate key present (exact or as a nested suffix), preferring the shallowest match. */
function pick(m: Map<string, unknown>, cands: string[]): [string, unknown] | null {
  for (const c of cands) {
    let best: [string, unknown] | null = null;
    for (const [k, v] of m) {
      if (v === null || v === undefined || v === "" || v === "-") continue;
      if (k === c || k.endsWith("." + c)) if (!best || k.length < best[0].length) best = [k, v];
    }
    if (best) return best;
  }
  return null;
}

const C = {
  api: ["api", "api_name", "apiname", "service.name", "route.name", "routername", "servicename", "route_name", "api_id", "apiid", "route_id", "service_id"],
  method: ["method", "httpmethod", "requestmethod", "request_method", "http_method", "apimethod", "verb"],
  path: ["path", "request.uri", "uri", "requestpath", "request_path", "uri_path", "resourcepath", "apiresourcetemplate", "requesturl", "request_url", "url", "upstream_uri", "resource"],
  status: ["status", "statuscode", "status_code", "response_code", "responsecode", "downstreamstatus", "proxyresponsecode", "code"],
  consumer: ["consumer", "username", "consumer_name", "alias", "app_name", "applicationname", "application", "clientusername", "client_id", "subscription", "clientid", "apikey", "api_key", "user"],
  latency: ["latency_ms", "latencies.request", "request_time", "latency_total", "latency", "time_to_serve_request", "responselatency", "proxyresponsetimems", "response_time", "responsetime", "requestduration", "duration", "elapsed"],
  bytes: ["bytes", "response.size", "bytes_sent", "responsesize", "response_size", "downstreamcontentsize", "responselength", "response_length", "body_bytes_sent"],
  ts: ["ts", "timestamp", "started_at", "start_time", "startutc", "time_stamp", "requesttimestamp", "datetime", "@timestamp", "requeststart", "time", "receivetimestamp"],
  count: ["count", "requests", "hits"],
};

function looksLikeRequest(o: unknown): boolean {
  const m = flatten(o);
  return !!(pick(m, C.status) && (pick(m, C.method) || pick(m, C.path)));
}

function toMs(key: string, v: unknown): number | null {
  if (typeof v === "string") {
    const s = v.trim();
    const m = s.match(/^([\d.]+)\s*(ns|µs|us|ms|s)?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const u = m[2] ?? "";
    if (u === "s") return n * 1000;
    if (u === "ns") return n / 1e6;
    if (u === "µs" || u === "us") return n / 1000;
    if (u === "ms") return n;
    v = n;
  }
  if (typeof v !== "number" || !isFinite(v)) return null;
  if (key.endsWith("duration") && v > 1e5) return v / 1e6; // Traefik reports nanoseconds
  if (key.endsWith("request_time") && v < 60 && !Number.isInteger(v)) return v * 1000; // NGINX $request_time is seconds
  return v;
}

function toTs(v: unknown): number {
  if (typeof v === "number") return v > 1e14 ? v / 1000 : v > 1e11 ? v : v * 1000;
  if (typeof v === "string") {
    if (/^\d+(\.\d+)?$/.test(v)) return toTs(Number(v));
    const p = Date.parse(v.replace(/^(\d{4})\/(\d{2})\/(\d{2}) - /, "$1-$2-$3T"));
    if (!isNaN(p)) return p;
  }
  return Date.now();
}

function cleanPath(p: string): string {
  let s = p;
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {
    /* keep */
  }
  return s.split("?")[0] || "/";
}

/** Collapse ids so /orders/123 and /orders/456 count as one API: /orders/:id */
export function apiFromPath(path: string): string {
  const segs = cleanPath(path)
    .split("/")
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => (/^\d+$/.test(s) || /^[0-9a-f-]{16,}$/i.test(s) || s.length > 32 ? ":id" : s));
  return "/" + segs.join("/");
}

export function normalize(o: unknown): GwRecord | null {
  const m = flatten(o);
  const st = pick(m, C.status);
  const status = st ? parseInt(String(st[1]), 10) : NaN;
  const meth = pick(m, C.method);
  const pth = pick(m, C.path);
  if (!(status >= 100 && status <= 599) && !meth && !pth) return null;
  const path = pth ? cleanPath(String(pth[1])) : "";
  const apiV = pick(m, C.api);
  const lat = pick(m, C.latency);
  const by = pick(m, C.bytes);
  const cnt = pick(m, C.count);
  const con = pick(m, C.consumer);
  return {
    api: (apiV && typeof apiV[1] !== "object" ? String(apiV[1]) : path ? apiFromPath(path) : "unknown").slice(0, 120),
    method: meth ? String(meth[1]).toUpperCase().slice(0, 10) : "",
    path: path.slice(0, 200),
    status: status >= 100 && status <= 599 ? status : 0,
    consumer: maskConsumer(con ? String(con[1]) : ""),
    latencyMs: lat ? toMs(lat[0], lat[1]) : null,
    bytes: by ? Number(by[1]) || 0 : 0,
    ts: toTs(pick(m, C.ts)?.[1]),
    count: cnt && Number(cnt[1]) > 0 ? Math.min(Number(cnt[1]), 1e9) : 1,
  };
}

/** Never store something that looks like a raw API key; keep a recognizable tail. */
function maskConsumer(c: string): string {
  const s = c.trim();
  if (s.length > 40 || /^(sk|pk|key|api)[-_]/i.test(s)) return "…" + s.slice(-6);
  return s.slice(0, 80);
}

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE";

/** Plain-text access logs: NGINX/Apache combined (3scale, Layer7, KrakenD behind NGINX), Gin (KrakenD), or text with embedded JSON. */
export function parseLine(line: string): GwRecord | null {
  const s = line.trim();
  if (!s) return null;
  const j = s.indexOf("{");
  if (j >= 0) {
    const parsed = safeJson(s.slice(j, s.lastIndexOf("}") + 1));
    if (parsed && typeof parsed === "object") {
      const r = normalize(parsed);
      if (r) return r;
    }
  }
  // NGINX / Apache combined: "GET /path HTTP/1.1" 200 1234 ... [optional $request_time at end]
  let m = s.match(new RegExp(`"(${METHODS}) ([^ "]+)[^"]*" (\\d{3}) (\\d+|-)`));
  if (m) {
    const t = s.match(/\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})\]/);
    const ts = t ? Date.parse(`${t[2]} ${t[1]} ${t[3]} ${t[4]} ${t[5]}`) : Date.now();
    const tail = s.match(/\s(\d+\.\d{3})$/);
    return {
      api: apiFromPath(m[2]),
      method: m[1],
      path: cleanPath(m[2]),
      status: +m[3],
      consumer: "",
      latencyMs: tail ? parseFloat(tail[1]) * 1000 : null,
      bytes: m[4] === "-" ? 0 : +m[4],
      ts: isNaN(ts) ? Date.now() : ts,
      count: 1,
    };
  }
  // Gin (KrakenD): [GIN] 2026/10/07 - 22:00:00 | 200 |   1.234ms |  10.0.0.1 | GET  "/path"
  m = s.match(new RegExp(`(\\d{4}\\/\\d{2}\\/\\d{2} - \\d{2}:\\d{2}:\\d{2})\\s*\\|\\s*(\\d{3})\\s*\\|\\s*([\\d.]+)\\s*(ns|µs|us|ms|s)\\s*\\|[^|]*\\|\\s*(${METHODS})\\s+"([^"]+)"`));
  if (m) {
    return {
      api: apiFromPath(m[6]),
      method: m[5],
      path: cleanPath(m[6]),
      status: +m[2],
      consumer: "",
      latencyMs: toMs("latency", m[3] + m[4]),
      bytes: 0,
      ts: toTs(m[1]),
      count: 1,
    };
  }
  // Last resort: METHOD /path ... 3-digit status
  m = s.match(new RegExp(`\\b(${METHODS})\\s+(\\/\\S*)`));
  const st = s.match(/\s([1-5]\d\d)(\s|$)/);
  if (m && st) return { api: apiFromPath(m[2]), method: m[1], path: cleanPath(m[2]), status: +st[1], consumer: "", latencyMs: null, bytes: 0, ts: Date.now(), count: 1 };
  return null;
}

/* ---------------- ingest ---------------- */

export async function gatewayHook(req: Request, env: Env, slug: string): Promise<Response> {
  const gw = GATEWAYS[slug];
  if (!gw) return new Response(`Unknown gateway "${slug}". Use one of: ${Object.keys(GATEWAYS).join(", ")}`, { status: 404 });

  // Oracle Notifications HTTPS subscription confirmation
  const ociConfirm = req.headers.get("x-oci-ns-confirmationurl");
  if (ociConfirm) {
    const u = new URL(ociConfirm);
    if (u.protocol === "https:" && /\.oraclecloud\.com$/.test(u.hostname)) {
      const r = await fetch(u.toString());
      await logEvent(env, slug, "subscription", r.ok ? "Confirmed OCI Notifications subscription" : `OCI confirmation failed (${r.status})`, {});
      return new Response("confirmed");
    }
    return new Response("Unexpected confirmation host", { status: 403 });
  }

  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > 10 * 1024 * 1024) return new Response("Body over 10 MB; send smaller batches", { status: 413 });
  const text = await bytesToText(raw);
  const ctx: Ctx = { records: [], depth: 0 };
  for (const v of parseText(text)) await unwrap(v, ctx);

  const stored = await storeRecords(env, slug, ctx.records);
  if (stored.requests === 0) {
    await logEvent(env, slug, "unrecognized", `${gw.name}: received ${raw.length} bytes but found no request records`, text.slice(0, 2000));
  }
  if (ctx.firehoseRequestId) {
    return new Response(JSON.stringify({ requestId: ctx.firehoseRequestId, timestamp: Date.now() }), { headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ gateway: slug, records: ctx.records.length, requests: stored.requests }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Aggregate records into per-day, per-API, per-consumer counters. */
export async function storeRecords(env: Env, slug: string, records: GwRecord[]): Promise<{ requests: number; keys: number }> {
  const agg = new Map<string, { day: string; api: string; consumer: string; n: number; e4: number; e5: number; lat: number; latN: number; bytes: number; last: number }>();
  let requests = 0;
  for (const r of records) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const k = `${day}|${r.api}|${r.consumer}`;
    let a = agg.get(k);
    if (!a) {
      if (agg.size >= 2000) continue; // guard against runaway cardinality in one post
      a = { day, api: r.api, consumer: r.consumer, n: 0, e4: 0, e5: 0, lat: 0, latN: 0, bytes: 0, last: 0 };
      agg.set(k, a);
    }
    a.n += r.count;
    requests += r.count;
    if (r.status >= 400 && r.status < 500) a.e4 += r.count;
    if (r.status >= 500) a.e5 += r.count;
    if (r.latencyMs != null && r.latencyMs >= 0) {
      a.lat += r.latencyMs * r.count;
      a.latN += r.count;
    }
    a.bytes += r.bytes;
    a.last = Math.max(a.last, r.ts);
  }
  const now = Date.now();
  const stmts = [...agg.values()].map((a) =>
    env.DB.prepare(
      "INSERT INTO gateway_usage(day, gateway, api, consumer, requests, err4xx, err5xx, latency_sum, latency_n, bytes, last_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(day, gateway, api, consumer) DO UPDATE SET requests = requests + excluded.requests, err4xx = err4xx + excluded.err4xx, " +
        "err5xx = err5xx + excluded.err5xx, latency_sum = latency_sum + excluded.latency_sum, latency_n = latency_n + excluded.latency_n, " +
        "bytes = bytes + excluded.bytes, last_at = MAX(last_at, excluded.last_at)",
    ).bind(a.day, slug, a.api, a.consumer, a.n, a.e4, a.e5, a.lat, a.latN, a.bytes, now),
  );
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return { requests, keys: agg.size };
}

/* ---------------- pricing ---------------- */

export interface PriceRule {
  id: string;
  gateway: string; // slug or *
  api: string; // glob, * wildcard
  per1k: number; // USD per 1,000 requests
}

function globRe(g: string): RegExp {
  return new RegExp("^" + g.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
}

/** First matching rule wins; null means the traffic is tracked but not priced. */
export function priceFor(rules: PriceRule[], gateway: string, api: string): number | null {
  for (const r of rules) {
    if ((r.gateway === "*" || r.gateway === gateway) && globRe(r.api || "*").test(api)) return r.per1k;
  }
  return null;
}
