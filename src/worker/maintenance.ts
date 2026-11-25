/**
 * Opportunistic maintenance.
 *
 * A Cron Trigger normally runs `runMaintenance`, but managed Workers hosts do
 * not always provide triggers. This scheduler runs the same cleanup at most
 * every 15 minutes, triggered by ordinary traffic, and never blocks a response.
 */

import { runMaintenance } from "./cleanup";
import type { Env } from "./types";

const INTERVAL_MS = 15 * 60 * 1000;
const KEY = "last_maintenance";

export async function maybeRunMaintenance(env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(KEY).first<{ value: string }>();
    const last = row ? Number(row.value) : 0;
    const now = Date.now();
    if (Number.isFinite(last) && now - last < INTERVAL_MS) return;

    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
      .bind(KEY, String(now))
      .run();

    ctx.waitUntil(
      runMaintenance(env)
        .then((stats) => console.log("clip:maintenance", JSON.stringify(stats)))
        .catch((error) => console.error("clip:maintenance failed", error instanceof Error ? error.message : String(error))),
    );
  } catch (error) {
    console.warn("clip:maintenance scheduling failed", error instanceof Error ? error.message : String(error));
  }
}
