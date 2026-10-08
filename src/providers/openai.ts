import type { CostRow, Env } from "../env";
import { fetchJson, HttpError } from "./http";

interface Resp {
  data: { start_time: number; results: { amount?: { value: number; currency: string }; line_item?: string | null }[] }[];
  has_more: boolean;
  next_page?: string | null;
}

/** OpenAI Costs API: GET /v1/organization/costs (daily buckets, admin key). */
export async function pullOpenAI(env: Env, from: string, to: string): Promise<CostRow[]> {
  try {
    return await run(env, from, to, true);
  } catch (e) {
    // If line-item grouping is rejected, fall back to daily totals
    if (e instanceof HttpError && e.status === 400) return run(env, from, to, false);
    throw e;
  }
}

async function run(env: Env, from: string, to: string, grouped: boolean): Promise<CostRow[]> {
  const rows: CostRow[] = [];
  let page: string | undefined;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({
      start_time: String(Date.parse(from + "T00:00:00Z") / 1000),
      end_time: String(Date.parse(to + "T00:00:00Z") / 1000),
      bucket_width: "1d",
      limit: "180",
    });
    if (grouped) q.append("group_by", "line_item");
    if (page) q.set("page", page);
    const res = await fetchJson<Resp>("https://api.openai.com/v1/organization/costs?" + q, {
      headers: { Authorization: "Bearer " + env.OPENAI_ADMIN_KEY },
    });
    for (const b of res.data) {
      const day = new Date(b.start_time * 1000).toISOString().slice(0, 10);
      for (const r of b.results) {
        if (!r.amount) continue;
        const service = r.line_item ? r.line_item.split(",")[0].trim() : "All usage";
        rows.push({ day, service, amount: Number(r.amount.value) || 0, currency: (r.amount.currency || "usd").toUpperCase() });
      }
    }
    if (!res.has_more || !res.next_page) break;
    page = res.next_page;
  }
  return rows;
}
