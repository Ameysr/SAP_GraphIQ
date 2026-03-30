import fs from 'fs';
import path from 'path';
import { getLocalEmbedding, getSemanticEmbedding, isSemanticReady } from './embedding.js';

export type ContractCheck =
  | { type: 'range'; field: string; min: number; max: number }
  | { type: 'regex'; field: string; pattern: string }
  | { type: 'monotonic'; field: string; direction: 'asc' | 'desc' };

export type ContractFormulaCheck =
  | {
      type: 'ratioPercent';
      numeratorField: string;
      denominatorField: string;
      targetField: string;
      tolerancePctPoints?: number; // e.g. 0.5 means +/-0.5 percentage points
    };

export interface ContractSpec {
  // Fields that must exist in result rows.
  requiredFields?: string[];
  // Value-level checks applied to the first row (for KPI-style outputs).
  checks?: ContractCheck[];
  // Formula checks across numeric fields.
  formulaChecks?: ContractFormulaCheck[];
  // Optional deterministic answer rendering template.
  // Supports `{{fieldName}}` replacements from the first row.
  answerTemplate?: string;
}

export interface QuestionPlan {
  id: string;
  critical?: boolean;
  functionName: string;
  params?: Record<string, unknown>;
  routingExamples: string[];
  contract?: ContractSpec;
}

export interface LoadedPlansConfig {
  minSimilarity?: number;
  topK?: number;
  plans: QuestionPlan[];
}

export interface PlanCandidate {
  plan: QuestionPlan;
  similarity: number;
}

let cachedConfig: LoadedPlansConfig | null = null;
let cachedExampleEmbeddings: Array<{
  plan: QuestionPlan;
  exampleEmbeddings: number[][];
}> = [];

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function coerceNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const n = Number.parseFloat(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function loadPlansConfig(): Promise<LoadedPlansConfig> {
  if (cachedConfig) return cachedConfig;

  const configPath = path.resolve(process.cwd(), 'config', 'question_plans.json');
  let raw = null;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    // Missing config => disable plan routing but keep system functional.
    cachedConfig = { minSimilarity: 0.65, topK: 3, plans: [] };
    return cachedConfig;
  }

  const parsed = JSON.parse(raw) as LoadedPlansConfig;
  cachedConfig = {
    minSimilarity: parsed.minSimilarity ?? 0.65,
    topK: parsed.topK ?? 3,
    plans: Array.isArray(parsed.plans) ? parsed.plans : [],
  };

  // Initial sync embeddings (TF-IDF) — always available immediately
  cachedExampleEmbeddings = cachedConfig.plans.map((plan) => ({
    plan,
    exampleEmbeddings: (plan.routingExamples ?? []).map((ex) => getLocalEmbedding(ex)),
  }));

  return cachedConfig;
}

// ── ASYNC RE-EMBED with semantic model once loaded ────────────────────────────
let semanticReembedDone = false;

async function reembedWithSemantic(): Promise<void> {
  if (semanticReembedDone || !isSemanticReady() || !cachedConfig) return;
  console.log('  [QuestionPlans] Re-embedding routing examples with semantic model...');
  const startMs = Date.now();

  const newEmbeddings = await Promise.all(
    cachedConfig.plans.map(async (plan) => ({
      plan,
      exampleEmbeddings: await Promise.all(
        (plan.routingExamples ?? []).map((ex) => getSemanticEmbedding(ex))
      ),
    }))
  );
  cachedExampleEmbeddings = newEmbeddings;
  semanticReembedDone = true;
  console.log(`  [QuestionPlans] ✓ Semantic re-embedding done in ${Date.now() - startMs}ms`);
}

/**
 * Initialize question plans with semantic embeddings.
 * Call at server startup after initEmbeddings().
 */
export async function initQuestionPlans(): Promise<void> {
  await loadPlansConfig();
  await reembedWithSemantic();
}

export async function getPlanCandidates(
  question: string,
  topKOverride?: number
): Promise<{ candidates: PlanCandidate[]; minSimilarity: number; topK: number }> {
  const config = await loadPlansConfig();
  // Trigger semantic re-embedding if model is now ready but we haven't re-embedded yet
  if (isSemanticReady() && !semanticReembedDone) {
    await reembedWithSemantic();
  }
  const topK = topKOverride ?? config.topK ?? 3;

  // Use semantic embedding if model is ready, else fallback to TF-IDF
  const qEmb = isSemanticReady()
    ? await getSemanticEmbedding(question)
    : getLocalEmbedding(question);

  const candidates: PlanCandidate[] = cachedExampleEmbeddings
    .map(({ plan, exampleEmbeddings }) => {
      const bestSim =
        exampleEmbeddings.length === 0
          ? 0
          : Math.max(...exampleEmbeddings.map((exEmb) => cosineSim(qEmb, exEmb)));
      return { plan, similarity: bestSim };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);

  return { candidates, minSimilarity: config.minSimilarity ?? 0.65, topK };
}

export function renderAnswerTemplate(template: string, row: Record<string, unknown>): string {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_match, fieldName: string) => {
    const key = String(fieldName).trim();
    const v = row[key];
    if (v === null || v === undefined) return '';
    return String(v);
  });
}

