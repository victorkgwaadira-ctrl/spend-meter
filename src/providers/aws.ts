import { AwsClient } from "aws4fetch";
import type { CostRow, Env } from "../env";
import { HttpError } from "./http";

interface Resp {
  ResultsByTime: {
    TimePeriod: { Start: string; End: string };
    Groups?: { Keys: string[]; Metrics: { UnblendedCost: { Amount: string; Unit: string } } }[];
  }[];
  NextPageToken?: string;
}

/**
 * AWS Cost Explorer GetCostAndUsage, daily, grouped by service.
 * Each request costs $0.01, so this runs every 6 hours by default.
 */
export async function pullAws(env: Env, from: string, to: string): Promise<CostRow[]> {
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    service: "ce",
    region: "us-east-1",
  });
  const rows: CostRow[] = [];
  let token: string | undefined;
  for (let i = 0; i < 10; i++) {
    const body: Record<string, unknown> = {
      TimePeriod: { Start: from, End: to },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    };
    if (token) body.NextPageToken = token;
    const res = await aws.fetch("https://ce.us-east-1.amazonaws.com/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSInsightsIndexService.GetCostAndUsage",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = JSON.parse(text).message || JSON.parse(text).Message || msg;
      } catch {
        /* keep text */
      }
      throw new HttpError(res.status, `AWS Cost Explorer returned ${res.status}: ${msg}`);
    }
    const data = JSON.parse(text) as Resp;
    for (const t of data.ResultsByTime) {
      for (const g of t.Groups ?? []) {
        const c = g.Metrics.UnblendedCost;
        rows.push({ day: t.TimePeriod.Start, service: g.Keys[0] || "Other", amount: parseFloat(c.Amount) || 0, currency: c.Unit || "USD" });
      }
    }
    if (!data.NextPageToken) break;
    token = data.NextPageToken;
  }
  return rows;
}
