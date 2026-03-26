export type IntentType =
  | 'LOOKUP' | 'TRAVERSE' | 'AGGREGATE'
  | 'DETECT' | 'COMPARE' | 'UNKNOWN';

export type ComplexityLevel = 'SIMPLE' | 'MEDIUM' | 'COMPLEX';
export type PathTaken = 'function' | 'template' | 'constrained' | 'schema';
export type TierNumber = 1 | 2 | 3;
export type LLMProvider = 'groq' | 'deepseek' | 'gemini';
export type Confidence = 'high' | 'medium' | 'low' | '';

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface EntityMap {
  SalesOrder?: string;
  Customer?: string;
  DeliveryHeader?: string;
  BillingHeader?: string;
  Product?: string;
  Plant?: string;
  [key: string]: string | undefined;
}

export interface SelectedFunction {
  name: string;
  params: Record<string, unknown>;
}

export interface QueryResult {
  [key: string]: unknown;
}

export interface FunctionResult {
  records: QueryResult[];
  metadata: { count: number; functionName: string };
}

export interface ObservabilityLog {
  timestamp: string;
  sessionId: string;
  cacheHit: boolean;
  tierUsed: TierNumber;
  intentType: IntentType | '';
  functionCalled: string;
  pathTaken: PathTaken | '';
  retryCount: number;
  latencyMs: number;
  recordsReturned: number;
  confidence: Confidence;
  usedFallback: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface FunctionDef {
  name: string;
  description: string;
  params: Record<string, string>;
}
