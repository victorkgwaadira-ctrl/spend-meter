import type { CostRow, Env, ProviderId } from "./env";
import { PROVIDERS } from "./env";
import { getSettings, recordRun, replaceCosts, saveSettings, syncWindow, type Settings } from "./db";
import { checkThresholds, configuredChannels, notify } from "./alerts";
import { knownMonths, monthSummary } from "./summary";
import { awsHook, azureHook, gcpHook, genericHook, twilioHook } from "./hooks";
import { pullAnthropic } from "./providers/anthropic";
import { pullOpenAI } from "./providers/openai";
import { pullAws } from "./providers/aws";
import { pullAzure } from "./providers/azure";
import { GATEWAYS, gatewayHook } from "./gateways";
import { connect, connectionStatus, disconnect, withStoredCreds, type StoredInfo } from "./connections";
import dashboard from "./dashboard.html";
import landing from "./landing.html";
import { demoState } from "./demo";
import { ensureSchema } from "./schema";

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect width="34" height="34" rx="9" fill="#0F1B2D"/><path d="M7 22a10 10 0 0 1 20 0" fill="none" stroke="#F2F4F6" stroke-width="2.4" stroke-linecap="round"/><path d="M17 22 L23.5 14" stroke="#F2A20C" stroke-width="2.6" stroke-linecap="round"/><circle cx="17" cy="22" r="2.4" fill="#F2F4F6"/></svg>`;

type Puller = { configured: (env: Env) => boolean; intervalMin: number; pull: (env: Env, from: string, to: string) => Promise<CostRow[]> };

const PULLERS: Partial<Record<ProviderId, Puller>> = {
  anthropic: { configured: (e) => !!e.ANTHROPIC_ADMIN_KEY, intervalMin: 55, pull: pullAnthropic },
  openai: { configured: (e) => !!e.OPENAI_ADMIN_KEY, intervalMin: 55, pull: pullOpenAI },
  aws: { configured: (e) => !!(e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY), intervalMin: 355, pull: pullAws },
  azure: {
    configured: (e) => !!(e.AZURE_TENANT_ID && e.AZURE_CLIENT_ID && e.AZURE_CLIENT_SECRET && e.AZURE_SUBSCRIPTION_IDS),
    intervalMin: 355,
    pull: pullAzure,
  },
};

async function syncAll(env: Env, force: boolean): Promise<Record<string, string>> {
  const settings = await getSettings(env);
  const { from, to } = syncWindow();
  const { results: runs } = await env.DB.prepare("SELECT provider, ran_at, ok FROM runs").all<{ provider: string; ran_at: number; ok: number }>();
  const last = new Map(runs.map((r) => [r.provider, r]));
  const out: Record<string, string> = {};

  await Promise.all(
    (Object.entries(PULLERS) as [ProviderId, Puller][]).map(async ([id, p]) => {
      if (!p.configured(env)) {
        out[id] = "not connected";
        return;
      }
      const prev = last.get(id);
      if (!force && prev && prev.ok && Date.now() - prev.ran_at < p.intervalMin * 60_000) {
        out[id] = "up to date";
        return;
      }
      try {
        const rows = await p.pull(env, from, to);
        await replaceCosts(env, id, from, to, rows, settings.fx);
        const nonUsd = [...new Set(rows.map((r) => r.currency.toUpperCase()).filter((c) => c !== "USD" && c !== "BWP"))];
        const msg = `Synced ${rows.length} line items from ${from}` + (nonUsd.length ? `. Note: amounts in ${nonUsd.join(", ")} are counted as USD.` : "");
        await recordRun(env, id, true, msg);
        out[id] = "synced";
      } catch (e) {
        const msg = (e as Error).message || String(e);
        await recordRun(env, id, false, msg);
        out[id] = "failed: " + msg;
      }
    }),
  );
  await checkThresholds(env);
  return out;
}

/* ---------- auth ---------- */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function dashboardAuthed(req: Request, env: Env): boolean {
  if (!env.DASHBOARD_PASSWORD) return false;
  const h = req.headers.get("Authorization") ?? "";
  if (!h.startsWith("Basic ")) return false;
  try {
    const [, pass] = atob(h.slice(6)).split(/:(.*)/s);
    return safeEqual(pass ?? "", env.DASHBOARD_PASSWORD);
  } catch {
    return false;
  }
}

function webhookAuthed(req: Request, url: URL, env: Env): boolean {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const t =
    url.searchParams.get("token") ??
    req.headers.get("X-Webhook-Token") ??
    req.headers.get("X-Amz-Firehose-Access-Key") ?? // Amazon Data Firehose access key
    (bearer || "");
  return !!env.WEBHOOK_TOKEN && safeEqual(t, env.WEBHOOK_TOKEN);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/* ---------- dashboard API ---------- */
async function state(env: Env, url: URL, raw: Env, info: StoredInfo) {
  const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") ?? "") ? url.searchParams.get("month")! : new Date().toISOString().slice(0, 7);
  const settings = await getSettings(env);
  const [summary, months, runs, events, alerts, gwSeen] = await Promise.all([
    monthSummary(env, month, settings),
    knownMonths(env),
    env.DB.prepare("SELECT * FROM runs").all(),
    env.DB.prepare("SELECT provider, kind, summary, received_at FROM events ORDER BY id DESC LIMIT 25").all(),
    env.DB.prepare("SELECT scope, level, sent_at, detail FROM alerts WHERE month = ? ORDER BY sent_at DESC").bind(month).all(),
    env.DB.prepare("SELECT gateway, MAX(last_at) AS last_at, SUM(requests) AS requests FROM gateway_usage GROUP BY gateway").all<{ gateway: string; last_at: number; requests: number }>(),
  ]);
  const seen = new Map(gwSeen.results.map((g) => [g.gateway, g]));
  const base = url.origin;
  const tok = encodeURIComponent(env.WEBHOOK_TOKEN ?? "");
  return {
    month,
    months,
    settings,
    summary,
    runs: runs.results,
    events: events.results,
    alerts: alerts.results,
    channels: configuredChannels(env),
    providers: Object.fromEntries(
      (Object.keys(PROVIDERS) as ProviderId[]).map((id) => [
        id,
        { name: PROVIDERS[id].name, connected: id === "gcp" ? null : !!PULLERS[id]?.configured(env), pulls: !!PULLERS[id] },
      ]),
    ),
    webhooks: {
      gcp: `${base}/hooks/gcp?token=${tok}`,
      aws: `${base}/hooks/aws?token=${tok}`,
      azure: `${base}/hooks/azure?token=${tok}`,
      twilio: `${base}/hooks/twilio?token=${tok}`,
      generic: `${base}/hooks/generic?token=${tok}`,
    },
    connections: connectionStatus(raw, env, info),
    gatewayBase: `${base}/hooks/gateway/`,
    webhookToken: env.WEBHOOK_TOKEN ?? "",
    gateways: Object.fromEntries(
      Object.entries(GATEWAYS).map(([slug, g]) => [slug, { ...g, lastAt: seen.get(slug)?.last_at ?? null, requests: seen.get(slug)?.requests ?? 0 }]),
    ),
  };
}

function cleanSettings(p: any): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (typeof p.budget === "number" && p.budget >= 0) out.budget = p.budget;
  if (typeof p.fx === "number" && p.fx > 0) out.fx = p.fx;
  if (Array.isArray(p.levels)) out.levels = p.levels.map(Number).filter((n: number) => n > 0 && n <= 1000).slice(0, 8);
  if (Array.isArray(p.rates))
    out.rates = p.rates.slice(0, 50).map((r: any) => ({
      id: String(r.id ?? crypto.randomUUID()).slice(0, 40),
      provider: String(r.provider ?? "").slice(0, 60),
      model: String(r.model ?? "").slice(0, 80),
      in: Number(r.in) || 0,
      out: Number(r.out) || 0,
    }));
  if (Array.isArray(p.priceRules))
    out.priceRules = p.priceRules.slice(0, 100).map((r: any) => ({
      id: String(r.id ?? crypto.randomUUID()).slice(0, 40),
      gateway: r.gateway === "*" || GATEWAYS[r.gateway] ? r.gateway : "*",
      api: String(r.api ?? "*").slice(0, 120) || "*",
      per1k: Math.max(0, Number(r.per1k) || 0),
    }));
  return out;
}

export default {
  async fetch(req: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path0 = url.pathname;
    const isStatic = path0 === "/" || path0 === "/demo" || path0.startsWith("/demo/") || path0.startsWith("/favicon") || path0 === "/health";
    if (!isStatic) await ensureSchema(rawEnv);
    const { env, info } = isStatic ? { env: rawEnv, info: { unreadable: [], updated: {} } } : await withStoredCreds(rawEnv);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") return json({ ok: true });
    if (path === "/" && req.method === "GET")
      return new Response(landing, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    if (path === "/demo" && req.method === "GET")
      return new Response(dashboard, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    if (path === "/demo/api/state" && req.method === "GET") return json(demoState(url));
    if (path.startsWith("/demo/api/")) return json({ error: "This is a demo. Changes aren't saved." }, 403);
    if (path === "/favicon.svg" || path === "/favicon.ico")
      return new Response(FAVICON, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });

    if (path.startsWith("/hooks/")) {
      if (req.method !== "POST") return new Response("Use POST", { status: 405 });
      if (!webhookAuthed(req, url, env)) return new Response("Bad token", { status: 401 });
      const gw = path.match(/^\/hooks\/gateway\/([\w-]+)$/);
      if (gw) return gatewayHook(req, env, gw[1]);
      switch (path) {
        case "/hooks/aws":
          return awsHook(req, env);
        case "/hooks/gcp":
          return gcpHook(req, env);
        case "/hooks/azure":
          return azureHook(req, env);
        case "/hooks/twilio":
          return twilioHook(req, env);
        case "/hooks/generic":
          return genericHook(req, env);
      }
      return new Response("Unknown webhook", { status: 404 });
    }

    if (!dashboardAuthed(req, env)) {
      return new Response("Sign in to API Spend Meter", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Spend Meter", charset="UTF-8"' },
      });
    }

    try {
      if ((path === "/app" || path === "/dashboard") && req.method === "GET")
        return new Response(dashboard, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

      if (path === "/api/state" && req.method === "GET") return json(await state(env, url, rawEnv, info));

      const conn = path.match(/^\/api\/connections\/([\w-]+)$/);
      if (conn && req.method === "POST") {
        const p: any = await req.json().catch(() => ({}));
        const r = await connect(rawEnv, env, conn[1], p.values ?? {}, !!p.force);
        if (r.ok && ["anthropic", "openai", "aws", "azure"].includes(conn[1])) {
          const fresh = (await withStoredCreds(rawEnv)).env;
          ctx.waitUntil(syncAll(fresh, true));
        }
        return json(r, r.ok ? 200 : 400);
      }
      if (conn && req.method === "DELETE") return json(await disconnect(rawEnv, conn[1]));

      if (path === "/api/settings" && req.method === "PUT") {
        await saveSettings(env, cleanSettings(await req.json()));
        ctx.waitUntil(checkThresholds(env));
        return json({ ok: true });
      }

      if (path === "/api/entries" && req.method === "POST") {
        const p: any = await req.json();
        const amount = Number(p.amount_usd);
        if (!(amount > 0) || !p.provider || !/^\d{4}-\d{2}-\d{2}$/.test(p.day)) return json({ error: "Provider, date and a cost above zero are required." }, 400);
        const id = "m-" + crypto.randomUUID();
        await env.DB.prepare("INSERT INTO entries(id, day, category, provider, service, usage, amount_usd, note, created_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .bind(
            id,
            p.day,
            ["ai", "cloud", "other"].includes(p.category) ? p.category : "other",
            String(p.provider).slice(0, 100),
            String(p.service ?? "").slice(0, 100),
            p.usage ? String(p.usage).slice(0, 200) : null,
            amount,
            p.note ? String(p.note).slice(0, 300) : null,
            Date.now(),
          )
          .run();
        ctx.waitUntil(checkThresholds(env));
        return json({ id });
      }

      const del = path.match(/^\/api\/entries\/([\w-]+)$/);
      if (del && req.method === "DELETE") {
        await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(del[1]).run();
        return json({ ok: true });
      }

      if (path === "/api/sync" && req.method === "POST") return json(await syncAll(env, true));

      if (path === "/api/test-alert" && req.method === "POST")
        return json(await notify(env, "Test alert from API Spend Meter", "If you can read this, alerts reach this channel."));

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },

  async scheduled(_event: ScheduledController, rawEnv: Env, ctx: ExecutionContext) {
    ctx.waitUntil(ensureSchema(rawEnv).then(() => withStoredCreds(rawEnv)).then(({ env }) => syncAll(env, false)));
  },
};
