import type { Env } from "./env";
import { PROVIDERS, type ProviderId } from "./env";
import { getSettings, type Settings } from "./db";
import { GATEWAYS, priceFor } from "./gateways";

export interface Item {
  id: string;
  day: string;
  source: "api" | "webhook" | "manual" | "gateway";
  providerId: string;
  provider: string;
  category: "ai" | "cloud" | "other";
  service: string;
  usage?: string | null;
  note?: string | null;
  currency?: string;
  amount: number; // USD
}

export interface MonthSummary {
  month: string;
  daysInMonth: number;
  elapsed: number; // days counted for the run-rate
  isCurrent: boolean;
  total: number;
  projected: number;
  budget: number;
  byProvider: { id: string; name: string; category: string; amount: number }[];
  daily: { ai: number; cloud: number; other: number }[];
  items: Item[];
  traffic: Traffic[];
}

export interface Traffic {
  gateway: string;
  gatewayName: string;
  api: string;
  requests: number;
  err4xx: number;
  err5xx: number;
  avgLatencyMs: number | null;
  bytes: number;
  consumers: number;
  per1k: number | null;
  cost: number;
  lastAt: number;
}

export async function monthSummary(env: Env, month: string, settings?: Settings): Promise<MonthSummary> {
  const s = settings ?? (await getSettings(env));
  const like = month + "-%";
  const [costs, entries] = await Promise.all([
    env.DB.prepare("SELECT provider, day, service, amount_usd, currency, source FROM costs WHERE day LIKE ?")
      .bind(like)
      .all<{ provider: ProviderId; day: string; service: string; amount_usd: number; currency: string; source: "api" | "webhook" }>(),
    env.DB.prepare("SELECT * FROM entries WHERE day LIKE ?")
      .bind(like)
      .all<{ id: string; day: string; category: "ai" | "cloud" | "other"; provider: string; service: string; usage: string; amount_usd: number; note: string }>(),
  ]);

  const items: Item[] = [];
  for (const c of costs.results) {
    const p = PROVIDERS[c.provider];
    items.push({
      id: `${c.provider}|${c.day}|${c.service}`,
      day: c.day,
      source: c.source,
      providerId: c.provider,
      provider: p?.name ?? c.provider,
      category: p?.category ?? "other",
      service: c.service,
      currency: c.currency,
      amount: c.amount_usd,
    });
  }
  for (const e of entries.results) {
    items.push({
      id: e.id,
      day: e.day,
      source: "manual",
      providerId: "manual:" + e.provider.toLowerCase(),
      provider: e.provider,
      category: e.category,
      service: e.service,
      usage: e.usage,
      note: e.note,
      amount: e.amount_usd,
    });
  }

  // Gateway traffic: priced traffic becomes cost items; everything shows in the traffic table
  const gw = await env.DB.prepare(
    "SELECT day, gateway, api, SUM(requests) AS requests, SUM(err4xx) AS e4, SUM(err5xx) AS e5, SUM(latency_sum) AS ls, SUM(latency_n) AS ln, " +
      "SUM(bytes) AS bytes, COUNT(DISTINCT consumer) AS consumers, MAX(last_at) AS last_at FROM gateway_usage WHERE day LIKE ? GROUP BY day, gateway, api",
  )
    .bind(like)
    .all<{ day: string; gateway: string; api: string; requests: number; e4: number; e5: number; ls: number; ln: number; bytes: number; consumers: number; last_at: number }>();
  const traffic = new Map<string, Traffic & { ls: number; ln: number }>();
  for (const g of gw.results) {
    const name = GATEWAYS[g.gateway]?.name ?? g.gateway;
    const per1k = priceFor(s.priceRules ?? [], g.gateway, g.api);
    const cost = per1k != null ? (g.requests / 1000) * per1k : 0;
    if (cost > 0) {
      items.push({
        id: `gw|${g.gateway}|${g.day}|${g.api}`,
        day: g.day,
        source: "gateway",
        providerId: "gw:" + g.gateway,
        provider: name,
        category: "other",
        service: g.api,
        usage: `${g.requests.toLocaleString("en-US")} requests × $${per1k}/1k`,
        amount: cost,
      });
    }
    const k = g.gateway + "|" + g.api;
    const t =
      traffic.get(k) ??
      { gateway: g.gateway, gatewayName: name, api: g.api, requests: 0, err4xx: 0, err5xx: 0, avgLatencyMs: null, bytes: 0, consumers: 0, per1k, cost: 0, lastAt: 0, ls: 0, ln: 0 };
    t.requests += g.requests;
    t.err4xx += g.e4;
    t.err5xx += g.e5;
    t.ls += g.ls;
    t.ln += g.ln;
    t.bytes += g.bytes;
    t.consumers = Math.max(t.consumers, g.consumers);
    t.cost += cost;
    t.lastAt = Math.max(t.lastAt, g.last_at);
    traffic.set(k, t);
  }
  const trafficList: Traffic[] = [...traffic.values()]
    .map(({ ls, ln, ...t }) => ({ ...t, avgLatencyMs: ln ? ls / ln : null }))
    .sort((a, b) => b.requests - a.requests);

  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const now = new Date();
  const curMonth = now.toISOString().slice(0, 7);
  const isCurrent = month === curMonth;
  const elapsed = isCurrent ? now.getUTCDate() : daysInMonth;

  const daily = Array.from({ length: daysInMonth }, () => ({ ai: 0, cloud: 0, other: 0 }));
  const byProv = new Map<string, { id: string; name: string; category: string; amount: number }>();
  let total = 0;
  for (const it of items) {
    total += it.amount;
    const d = Number(it.day.slice(8)) - 1;
    if (daily[d]) daily[d][it.category] += it.amount;
    const key = it.providerId;
    const p = byProv.get(key) ?? { id: key, name: it.provider, category: it.category, amount: 0 };
    p.amount += it.amount;
    byProv.set(key, p);
  }
  items.sort((a, b) => b.day.localeCompare(a.day) || b.amount - a.amount);

  return {
    month,
    daysInMonth,
    elapsed,
    isCurrent,
    total,
    projected: isCurrent && elapsed > 0 ? (total / elapsed) * daysInMonth : total,
    budget: s.budget,
    byProvider: [...byProv.values()].sort((a, b) => b.amount - a.amount),
    daily,
    items,
    traffic: trafficList,
  };
}

export async function knownMonths(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT substr(day,1,7) AS m FROM costs UNION SELECT DISTINCT substr(day,1,7) FROM entries " +
      "UNION SELECT DISTINCT substr(day,1,7) FROM gateway_usage ORDER BY m DESC",
  ).all<{ m: string }>();
  const cur = new Date().toISOString().slice(0, 7);
  const set = new Set([cur, ...results.map((r) => r.m)]);
  return [...set].sort().reverse();
}
