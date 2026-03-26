/**
 * Resume Ingestion Script
 * 
 * Picks up from where ingest.ts failed.
 * It only runs the remaining relationships that weren't completed.
 * Uses smaller batches (25) and longer delays (1.5s) to avoid
 * overwhelming the Neo4j Aura free tier.
 * 
 * Usage: npx tsx scripts/resume-ingest.ts
 */

import { getDriver } from '../db.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const BATCH_SIZE = 25;  // Much smaller to avoid connection drops
const DELAY_MS = 1500;  // Longer delay between batches
const NEO4J_DATABASE = process.env.NEO4J_DATABASE ?? 'neo4j';

type RawRecord = Record<string, unknown>;

function str(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonlFiles(collectionDir: string): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const files = fs.readdirSync(collectionDir).filter((f) => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(collectionDir, file);
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as RawRecord);
      } catch {
        // skip malformed
      }
    }
  }
  return records;
}

// ── RESILIENT SINGLE-RECORD MERGE ─────────────────────────────────────────────
// Instead of wrapping a whole batch in one transaction (which rolls back entirely
// on any error), this processes each record in its own session/transaction.
async function resilientMerge(
  cypher: string,
  records: RawRecord[],
  paramsFn: (rec: RawRecord) => Record<string, unknown>,
  label: string,
  startFrom: number = 0
): Promise<{ processed: number; skipped: number }> {
  const driver = getDriver();
  let processed = 0;
  let skipped = 0;
  let consecutiveErrors = 0;

  const total = records.length;
  const subset = records.slice(startFrom);

  console.log(`  Starting from record ${startFrom}, ${subset.length} remaining`);

  for (let i = 0; i < subset.length; i++) {
    const rec = subset[i];
    const session = driver.session({ database: NEO4J_DATABASE });

    try {
      const params = paramsFn(rec);
      await session.executeWrite(async (tx) => {
        await tx.run(cypher, params);
      });
      processed++;
      consecutiveErrors = 0;

      // Progress update every 500 records
      if (processed % 500 === 0) {
        const pct = ((startFrom + i + 1) / total * 100).toFixed(1);
        console.log(`  ... ${processed} done (${pct}% of total)`);
      }
    } catch (err: unknown) {
      skipped++;
      consecutiveErrors++;

      if (skipped <= 5) {
        console.warn(`  ⚠ Skipped record ${startFrom + i}: ${err instanceof Error ? err.message.substring(0, 80) : 'unknown'}`);
      }

      // If we get 10 consecutive errors, pause for 5 seconds
      if (consecutiveErrors >= 10) {
        console.warn(`  ⏸ 10 consecutive errors — pausing 5s before retry...`);
        await sleep(5000);
        consecutiveErrors = 0;
      }
    } finally {
      await session.close();
    }

    // Throttle: pause every batch
    if ((i + 1) % BATCH_SIZE === 0) {
      await sleep(DELAY_MS);
    }
  }

  return { processed, skipped };
}

// ── RELATIONSHIPS TO RESUME ───────────────────────────────────────────────────
// These are the relationships that failed or were never attempted.
// Comment out any that already succeeded on your last run.

interface ResumeTask {
  name: string;
  sourceFolder: string;
  cypher: string;
  paramsFn: (r: RawRecord) => Record<string, unknown>;
  startFrom?: number;
}

const RESUME_TASKS: ResumeTask[] = [
  {
    name: 'ProductStorageLocation-FOR_PRODUCT->Product',
    sourceFolder: 'product_storage_locations',
    cypher: `
      MATCH (psl:ProductStorageLocation {id: $pslId})
      MATCH (p:Product {id: $product})
      MERGE (psl)-[:FOR_PRODUCT]->(p)
    `,
    paramsFn: (r) => ({
      pslId: str(r.product) + '_' + str(r.plant) + '_' + str(r.storageLocation),
      product: str(r.product),
    }),
    startFrom: 0,  // Starts fresh since the previous attempt rolled back
  },
  {
    name: 'ProductStorageLocation-AT_PLANT->Plant',
    sourceFolder: 'product_storage_locations',
    cypher: `
      MATCH (psl:ProductStorageLocation {id: $pslId})
      MATCH (pl:Plant {id: $plant})
      MERGE (psl)-[:AT_PLANT]->(pl)
    `,
    paramsFn: (r) => ({
      pslId: str(r.product) + '_' + str(r.plant) + '_' + str(r.storageLocation),
      plant: str(r.plant),
    }),
    startFrom: 0,
  },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║  SAP O2C Resume Ingestion                 ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`Batch size: ${BATCH_SIZE} | Delay: ${DELAY_MS}ms`);
  console.log(`Tasks to resume: ${RESUME_TASKS.length}\n`);

  const startTime = Date.now();

  for (const task of RESUME_TASKS) {
    const collectionDir = path.join(DATA_DIR, task.sourceFolder);
    if (!fs.existsSync(collectionDir)) {
      console.warn(`⚠ Folder not found: ${task.sourceFolder} — skipping`);
      continue;
    }

    console.log(`\n[${task.name}] Reading ${task.sourceFolder}...`);
    const records = await readJsonlFiles(collectionDir);
    console.log(`  Total records: ${records.length}`);

    if (records.length === 0) {
      console.log(`  No records, skipping`);
      continue;
    }

    const { processed, skipped } = await resilientMerge(
      task.cypher,
      records,
      task.paramsFn,
      task.name,
      task.startFrom ?? 0
    );

    console.log(`  ✓ ${task.name}: ${processed} processed, ${skipped} skipped`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Resume complete in ${elapsed}s`);

  const driver = getDriver();
  await driver.close();
}

main().catch((err) => {
  console.error('Resume failed:', err);
  process.exit(1);
});
