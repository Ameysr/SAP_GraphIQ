/**
 * Quick migration: Patch existing Neo4j nodes with missing fields.
 * - Product nodes: add productType (ZFS1, ZF01, ZPKG)
 * - SalesOrderItem nodes: add salesOrderItemCategory (TAN)
 *
 * Run: npx tsx scripts/patch-missing-fields.ts
 */
import { getDriver } from '../db.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const NEO4J_DATABASE = process.env.NEO4J_DATABASE ?? 'neo4j';

type RawRecord = Record<string, unknown>;

function str(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

async function readJsonlFiles(dir: string): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, file)),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return records;
}

async function main() {
  const driver = getDriver();

  // ── 1. Patch Product nodes with productType ──
  console.log('\n[Patch] Reading products...');
  const productDir = path.join(DATA_DIR, 'products');
  const products = await readJsonlFiles(productDir);
  console.log(`  Found ${products.length} product records`);

  let patched = 0;
  for (const rec of products) {
    const productId = str(rec.product);
    const productType = str(rec.productType);
    if (!productId || !productType) continue;

    const session = driver.session({ database: NEO4J_DATABASE });
    try {
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (p:Product {id: $id}) SET p.productType = $productType RETURN p.id`,
          { id: productId, productType }
        )
      );
      patched++;
    } catch (err) {
      console.warn(`  Failed to patch Product ${productId}:`, err instanceof Error ? err.message.slice(0, 80) : '');
    } finally {
      await session.close();
    }
  }
  console.log(`  ✓ Patched ${patched} Product nodes with productType`);

  // ── 2. Patch SalesOrderItem nodes with salesOrderItemCategory ──
  console.log('\n[Patch] Reading sales_order_items...');
  const soiDir = path.join(DATA_DIR, 'sales_order_items');
  const items = await readJsonlFiles(soiDir);
  console.log(`  Found ${items.length} sales order item records`);

  patched = 0;
  for (const rec of items) {
    const itemId = str(rec.salesOrder) + '_' + str(rec.salesOrderItem);
    const category = str(rec.salesOrderItemCategory);
    if (!itemId || !category) continue;

    const session = driver.session({ database: NEO4J_DATABASE });
    try {
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (soi:SalesOrderItem {id: $id}) SET soi.salesOrderItemCategory = $category RETURN soi.id`,
          { id: itemId, category }
        )
      );
      patched++;
    } catch (err) {
      console.warn(`  Failed to patch SOI ${itemId}:`, err instanceof Error ? err.message.slice(0, 80) : '');
    } finally {
      await session.close();
    }
  }
  console.log(`  ✓ Patched ${patched} SalesOrderItem nodes with salesOrderItemCategory`);

  // ── Done ──
  await driver.close();
  console.log('\n✅ Migration complete!\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
