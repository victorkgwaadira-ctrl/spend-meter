import type { Env } from "./env";
import schemaSql from "../schema.sql";

let ready: Promise<void> | null = null;

/** Statements from schema.sql, without comments. All are CREATE ... IF NOT EXISTS, so running them is safe. */
export function schemaStatements(sql: string = schemaSql): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Create the tables on first use, once per Worker instance, so a fresh deploy
 * (including the Deploy to Cloudflare button) works with no manual database step.
 */
export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = env.DB.batch(schemaStatements().map((s) => env.DB.prepare(s)))
      .then(() => undefined)
      .catch((e) => {
        ready = null; // retry on the next request
        throw e;
      });
  }
  return ready;
}
