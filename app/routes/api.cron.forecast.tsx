import { json, type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runForecast } from "../services/forecast.server";
import * as fs from "fs";
import * as path from "path";

/**
 * Staggered Forecast Processor
 * 
 * Architecture:
 *   1. Once per day, snapshots all shops into a queue file
 *   2. Every N minutes, processes the next batch from that queue
 *   3. Spreads all shops evenly across a 6-hour window
 *   4. New customers join the queue on the next daily rebuild
 * 
 * No thundering herd. No per-tick DB queries for the shop list.
 * Self-healing: if the queue file is missing or corrupt, it rebuilds.
 * 
 *   Cron expression: every 5 minutes
 *   curl -sf -H 'X-Cron-Secret: ...' .../api/cron/forecast
 */

const QUEUE_FILE = path.join(process.cwd(), ".forecast-queue.json");
const WINDOW_HOURS = 6;
const QUEUE_MAX_AGE_MS = WINDOW_HOURS * 60 * 60 * 1000; // 4 cycles per day

interface QueueState {
  builtAt: string;       // ISO timestamp
  shops: string[];       // Ordered shop list
  cursor: number;        // Next shop index to process
  cycleComplete: boolean;
}

function loadQueue(): QueueState | null {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    // Validate age
    if (Date.now() - new Date(data.builtAt).getTime() > QUEUE_MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function saveQueue(state: QueueState) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Auth
  const cronSecret = process.env.CRON_SECRET;
  const provided = request.headers.get("X-Cron-Secret") ||
    new URL(request.url).searchParams.get("secret");
  if (!cronSecret || provided !== cronSecret) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Load or rebuild queue
  let queue = loadQueue();

  if (!queue) {
    // Daily rebuild: snapshot all shops, shuffle for fairness
    console.log("[Cron Forecast] Building daily shop queue...");
    const configs = await prisma.appConfiguration.findMany({
      select: { shop: true }
    });

    // Fisher-Yates shuffle so no shop is always first/last
    const shops = configs.map(c => c.shop);
    for (let i = shops.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shops[i], shops[j]] = [shops[j], shops[i]];
    }

    queue = {
      builtAt: new Date().toISOString(),
      shops,
      cursor: 0,
      cycleComplete: false
    };
    saveQueue(queue);
    console.log(`[Cron Forecast] Queue built: ${shops.length} shops`);
  }

  // 2. If cycle already complete, nothing to do until queue expires
  if (queue.cycleComplete) {
    return json({
      status: "idle",
      message: "Current cycle complete. Next queue rebuild in " +
        Math.round((QUEUE_MAX_AGE_MS - (Date.now() - new Date(queue.builtAt).getTime())) / 3600000) + "h",
      totalShops: queue.shops.length,
      processed: queue.cursor
    });
  }

  // 3. Calculate batch size to finish within the 6-hour window
  //    remaining shops / remaining 5-min ticks in window
  const elapsedSinceBuilt = Date.now() - new Date(queue.builtAt).getTime();
  const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
  const remainingWindowMs = Math.max(windowMs - elapsedSinceBuilt, 5 * 60 * 1000);
  const remainingTicks = Math.max(Math.floor(remainingWindowMs / (5 * 60 * 1000)), 1);
  const remainingShops = queue.shops.length - queue.cursor;
  const batchSize = Math.max(Math.ceil(remainingShops / remainingTicks), 1);

  // Cap at a reasonable max to prevent overload
  const maxBatch = parseInt(new URL(request.url).searchParams.get("max") || "50", 10);
  const actualBatch = Math.min(batchSize, maxBatch, remainingShops);

  if (actualBatch === 0) {
    queue.cycleComplete = true;
    saveQueue(queue);
    return json({ status: "complete", totalShops: queue.shops.length });
  }

  // 4. Process this batch
  const batch = queue.shops.slice(queue.cursor, queue.cursor + actualBatch);
  console.log(`[Cron Forecast] Processing batch: shops ${queue.cursor + 1}-${queue.cursor + batch.length} of ${queue.shops.length} (batch=${actualBatch})`);

  const results: { shop: string; products: number; ms: number; error?: string }[] = [];

  for (const shop of batch) {
    const start = Date.now();
    try {
      const { admin } = await unauthenticated.admin(shop);
      const forecasts = await runForecast(shop, admin);
      results.push({ shop, products: forecasts.length, ms: Date.now() - start });
    } catch (err: any) {
      console.error(`[Cron Forecast] ${shop} failed:`, err.message);
      results.push({ shop, products: 0, ms: Date.now() - start, error: err.message });
    }
  }

  // 5. Advance cursor
  queue.cursor += batch.length;
  if (queue.cursor >= queue.shops.length) {
    queue.cycleComplete = true;
  }
  saveQueue(queue);

  return json({
    status: queue.cycleComplete ? "complete" : "processing",
    progress: `${queue.cursor}/${queue.shops.length}`,
    batchSize: actualBatch,
    remainingTicks,
    processed: results.length,
    errors: results.filter(r => r.error).length,
    avgMs: Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length),
    details: results
  });
};
