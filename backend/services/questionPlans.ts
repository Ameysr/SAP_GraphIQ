import fs from 'fs';
import path from 'path';
import { getLocalEmbedding } from './embedding.js';
import { cosineSimilarity } from '../utils/math.js';

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

/**
 * Initialize question plans.
 * Call at server startup.
 */
export async function initQuestionPlans(): Promise<void> {
  await loadPlansConfig();
  console.log(`  [QuestionPlans] ✓ ${cachedConfig?.plans.length ?? 0} plans loaded with TF-IDF embeddings`);
}

export async function getPlanCandidates(
  question: string,
  topKOverride?: number
): Promise<{ candidates: PlanCandidate[]; minSimilarity: number; topK: number }> {
  const config = await loadPlansConfig();
  const topK = topKOverride ?? config.topK ?? 3;

  const qEmb = getLocalEmbedding(question);

  const candidates: PlanCandidate[] = cachedExampleEmbeddings
    .map(({ plan, exampleEmbeddings }) => {
      const bestSim =
        exampleEmbeddings.length === 0
          ? 0
          : Math.max(...exampleEmbeddings.map((exEmb) => cosineSimilarity(qEmb, exEmb)));
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

