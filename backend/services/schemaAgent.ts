// ── SCHEMA DISCOVERY AGENT ────────────────────────────────────────────────────
// Introspects the Neo4j database on startup to discover ALL node labels,
// properties, relationship types, and sample values. This replaces hardcoded
// schema maps so the LLM always knows the full database structure.
//
// Why: Without this, the LLM can't generate Cypher for fields it doesn't
// know about (e.g., product.baseUnit, billingItem.billingQuantityUnit).
// With this, novel queries about ANY field work automatically.

import { runQuery } from '../db.js';

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface NodeProperty {
  name: string;
  types: string[];          // e.g. ["String"], ["Boolean"], ["Long"]
  sampleValues: unknown[];  // 3-5 real values from the DB
}

export interface NodeSchema {
  label: string;
  properties: NodeProperty[];
  count: number;
}

export interface RelationshipSchema {
  type: string;
  fromLabel: string;
  toLabel: string;
  count: number;
}

export interface LiveSchema {
  nodes: NodeSchema[];
  relationships: RelationshipSchema[];
  discoveredAt: string;
  totalNodeLabels: number;
  totalRelTypes: number;
  totalProperties: number;
}

// ── SINGLETON ─────────────────────────────────────────────────────────────────

let _liveSchema: LiveSchema | null = null;

export function getLiveSchema(): LiveSchema | null {
  return _liveSchema;
}

// ── CONVENIENCE GETTERS (for hybridExecutor validation) ───────────────────────

export function getValidNodeLabels(): Set<string> {
  if (!_liveSchema) return new Set();
  return new Set(_liveSchema.nodes.map(n => n.label));
}

export function getValidRelationships(): Set<string> {
  if (!_liveSchema) return new Set();
  return new Set(_liveSchema.relationships.map(r => r.type));
}

// ── FORMAT: Build LLM-readable schema string for a given node label ──────────

function formatNodeSchema(node: NodeSchema): string {
  const props = node.properties.map(p => {
    const typeStr = p.types.join('|');

    // Determine Neo4j type hint for the LLM
    let hint = '';
    if (typeStr.includes('Boolean')) {
      hint = '(boolean)';
    } else if (typeStr.includes('Long') || typeStr.includes('Double') || typeStr.includes('Float')) {
      hint = '(number)';
    } else {
      hint = '(string)';
    }

    // Add sample values for context
    const samples = p.sampleValues
      .filter(v => v !== null && v !== undefined)
      .slice(0, 3);
    const sampleStr = samples.length > 0
      ? `, e.g. ${samples.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ')}`
      : '';

    // Special hints for known tricky fields
    const lowerName = p.name.toLowerCase();
    let specialHint = '';
    if (/(amount|netamount|totalnetamount|totalamount)$/i.test(p.name) && typeStr.includes('String')) {
      specialHint = ' — use toFloat() before arithmetic';
    }
    if (/date$/i.test(p.name) && typeStr.includes('String')) {
      specialHint = ' — string "YYYY-MM-DD", use date() to convert';
    }
    if (/(iscancelled|isblocked|ismarkedfor)/i.test(p.name) && typeStr.includes('Boolean')) {
      specialHint = ' — use = true / = false';
    }

    return `${p.name}${hint}${sampleStr}${specialHint}`;
  });

  return `${node.label} {${props.join(', ')}}`;
}

// ── PUBLIC: Get formatted schema for specific node labels ─────────────────────

export function getFormattedNodeSchema(label: string): string | null {
  if (!_liveSchema) return null;
  const node = _liveSchema.nodes.find(n => n.label === label);
  if (!node) return null;
  return formatNodeSchema(node);
}

export function getAllFormattedSchemas(): Record<string, string> {
  if (!_liveSchema) return {};
  const result: Record<string, string> = {};
  for (const node of _liveSchema.nodes) {
    result[node.label] = formatNodeSchema(node);
  }
  return result;
}

// ── PUBLIC: Get relationship strings ──────────────────────────────────────────

export function getRelationshipsForNode(label: string): string[] {
  if (!_liveSchema) return [];
  return _liveSchema.relationships
    .filter(r => r.fromLabel === label || r.toLabel === label)
    .map(r => `(${r.fromLabel})-[:${r.type}]->(${r.toLabel})`);
}

export function getAllRelationshipStrings(): string[] {
  if (!_liveSchema) return [];
  return _liveSchema.relationships.map(r =>
    `(${r.fromLabel})-[:${r.type}]->(${r.toLabel})`
  );
}

// ── DISCOVERY ─────────────────────────────────────────────────────────────────

export async function discoverSchema(): Promise<LiveSchema> {
  console.log('  [SchemaAgent] Starting schema discovery from Neo4j...');
  const startTime = Date.now();

  // ── Step 1: Discover all node labels and their counts ──
  const labelResults = await runQuery(`
    MATCH (n)
    WITH labels(n)[0] AS label, count(n) AS cnt
    RETURN label, cnt
    ORDER BY cnt DESC
  `, {});

  const labels = labelResults
    .map(r => ({ label: r.label as string, count: r.cnt as number }))
    .filter(r => r.label); // Filter out null labels

  console.log(`  [SchemaAgent] Found ${labels.length} node labels: ${labels.map(l => l.label).join(', ')}`);

  // ── Step 2: For each label, discover properties with types and sample values ──
  const nodeSchemas: NodeSchema[] = [];

  for (const { label, count } of labels) {
    try {
      // Adaptive sample size: small collections get full scan,
      // large collections get representative sample.
      // This ensures we discover ALL property keys, even sparse ones.
      const sampleLimit = count <= 500 ? count : count <= 5000 ? 100 : 50;
      
      // Get ALL property keys across the sampled nodes
      const propResults = await runQuery(`
        MATCH (n:\`${label}\`)
        WITH n LIMIT ${sampleLimit}
        UNWIND keys(n) AS propKey
        WITH propKey, collect(n[propKey])[0..5] AS samples
        RETURN propKey, samples
        ORDER BY propKey
      `, {});

      const properties: NodeProperty[] = propResults.map(r => {
        const samples = (r.samples as unknown[]) ?? [];
        // Infer type from sample values
        const types: string[] = [];
        for (const s of samples) {
          if (s === null || s === undefined) continue;
          if (typeof s === 'boolean') { if (!types.includes('Boolean')) types.push('Boolean'); }
          else if (typeof s === 'number') { if (!types.includes('Long')) types.push('Long'); }
          else if (typeof s === 'string') { if (!types.includes('String')) types.push('String'); }
          else { if (!types.includes('Object')) types.push('Object'); }
        }
        if (types.length === 0) types.push('String'); // Default

        return {
          name: r.propKey as string,
          types,
          sampleValues: samples.filter(s => s !== null && s !== undefined).slice(0, 3),
        };
      });

      nodeSchemas.push({ label, properties, count });
    } catch (err) {
      console.log(`  [SchemaAgent] Warning: Could not introspect ${label}: ${(err as Error).message?.substring(0, 60)}`);
      nodeSchemas.push({ label, properties: [], count });
    }
  }

  // ── Step 3: Discover all relationship types with start/end labels ──
  const relResults = await runQuery(`
    MATCH (a)-[r]->(b)
    WITH labels(a)[0] AS fromLabel, type(r) AS relType, labels(b)[0] AS toLabel, count(r) AS cnt
    RETURN fromLabel, relType, toLabel, cnt
    ORDER BY cnt DESC
  `, {});

  const relationships: RelationshipSchema[] = relResults.map(r => ({
    type: r.relType as string,
    fromLabel: r.fromLabel as string,
    toLabel: r.toLabel as string,
    count: r.cnt as number,
  }));

  console.log(`  [SchemaAgent] Found ${relationships.length} relationship types`);

  // ── Step 4: Build and store the live schema ──
  const totalProperties = nodeSchemas.reduce((sum, n) => sum + n.properties.length, 0);

  _liveSchema = {
    nodes: nodeSchemas,
    relationships,
    discoveredAt: new Date().toISOString(),
    totalNodeLabels: nodeSchemas.length,
    totalRelTypes: relationships.length,
    totalProperties,
  };

  const elapsed = Date.now() - startTime;
  console.log(`  [SchemaAgent] Schema discovery complete in ${elapsed}ms`);
  console.log(`  [SchemaAgent] ${nodeSchemas.length} node types, ${relationships.length} relationship types, ${totalProperties} properties discovered`);

  // Log a summary of discovered properties per node (helpful for debugging)
  for (const node of nodeSchemas) {
    const propNames = node.properties.map(p => p.name).join(', ');
    console.log(`    ${node.label} (${node.count} nodes): ${propNames}`);
  }

  return _liveSchema;
}
