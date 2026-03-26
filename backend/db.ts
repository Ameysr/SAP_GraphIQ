import neo4j, { Driver, Session } from 'neo4j-driver';
import dotenv from 'dotenv';
import type { QueryResult } from './types/index.js';

dotenv.config({ path: '../.env' });

const NEO4J_URI = process.env.NEO4J_URI ?? '';
const NEO4J_USER = process.env.NEO4J_USER ?? 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? '';
const NEO4J_DATABASE = process.env.NEO4J_DATABASE ?? 'neo4j';

let driver: Driver | null = null;

function initDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
      {
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 5000,
      }
    );
  }
  return driver;
}

export function getDriver(): Driver {
  return initDriver();
}

export async function runQuery(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<QueryResult[]> {
  const d = initDriver();
  let session: Session | null = null;
  try {
    session = d.session({ database: NEO4J_DATABASE });
    const result = await session.executeRead(async (tx) => {
      return tx.run(cypher, params);
    }, { timeout: 30000 });

    return result.records.map((record) => {
      const obj: QueryResult = {};
      for (const key of record.keys) {
        const val = record.get(key as string);
        obj[key as string] = neo4jValueToJs(val);
      }
      return obj;
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    
    // User-friendly error classification
    if (msg.includes('timeout') || msg.includes('Timeout')) {
      throw new Error('Query timeout — the question requires too much computation. Try asking for fewer records or a simpler aggregation.');
    }
    if (msg.includes('SyntaxError') || msg.includes('Invalid input')) {
      console.error(`  [Neo4j] Cypher syntax error: ${msg.substring(0, 200)}`);
      throw new Error('Generated query had a syntax error — please rephrase your question.');
    }
    if (msg.includes('MemoryPool') || msg.includes('memory')) {
      throw new Error('Query used too much memory — try asking about fewer entities or add a LIMIT.');
    }
    if (msg.includes('connection') || msg.includes('Connection') || msg.includes('ECONNREFUSED')) {
      throw new Error('Database connection issue — please try again in a moment.');
    }
    if (msg.includes('Unknown function') || msg.includes('Type mismatch')) {
      console.error(`  [Neo4j] Query error: ${msg.substring(0, 200)}`);
      throw new Error('Query structure error — please rephrase your question differently.');
    }
    throw new Error(`Database query failed: ${msg.substring(0, 200)}`);
  } finally {
    if (session) {
      await session.close();
    }
  }
}

function neo4jValueToJs(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object' && val !== null) {
    // Neo4j Integer
    if ('low' in val && 'high' in val && typeof (val as Record<string, unknown>).toNumber === 'function') {
      return (val as unknown as { toNumber(): number }).toNumber();
    }
    // Neo4j Node
    if ('labels' in val && 'properties' in val) {
      const node = val as { labels: string[]; properties: Record<string, unknown>; identity: unknown };
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.properties)) {
        props[k] = neo4jValueToJs(v);
      }
      return {
        labels: node.labels,
        ...props,
      };
    }
    // Neo4j Relationship
    if ('type' in val && 'properties' in val && 'start' in val && 'end' in val) {
      return {
        type: (val as { type: string }).type,
      };
    }
    // Array
    if (Array.isArray(val)) {
      return val.map(neo4jValueToJs);
    }
    // Plain object
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      result[k] = neo4jValueToJs(v);
    }
    return result;
  }
  return val;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
