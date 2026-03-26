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

export interface GraphNodeConnection {
  relType: string;
  neighbor: GraphNode;
}

export interface GraphNodeDetails {
  node: GraphNode;
  connections: GraphNodeConnection[];
  connectionsCount?: number;
}

export type Confidence = 'high' | 'medium' | 'low' | '';

export interface ChatMetadata {
  tier: number;
  cacheHit: boolean;
  latencyMs: number;
  usedFallback: boolean;
  pathTaken: string;
  recordCount?: number;
  intent?: string;
  functionCalled?: string | null;
  executedCypher?: string | null;
  contractVerified?: boolean | null;
  activePlanId?: string | null;
  contractReason?: string | null;
  activePlanCritical?: boolean | null;
}

export interface ChatResponse {
  answer: string;
  nodesReferenced: string[];
  confidence: Confidence;
  metadata: ChatMetadata;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  metadata?: ChatMetadata;
  confidence?: Confidence;
  nodesReferenced?: string[];
}

export interface AdminStats {
  cacheHitRate: number;
  tierDistribution: { 1: number; 2: number; 3: number };
  fallbackRate: number;
  avgLatencyMs: number;
  topFunctions: Array<{ name: string; count: number }>;
  failedQueryCount: number;
  totalRequests: number;
}

export const NODE_COLORS: Record<string, string> = {
  Customer: '#FF3366',       // Vivid Pink
  SalesOrder: '#33CCFF',     // Sky Blue
  SalesOrderItem: '#80DFFF', // Lighter Sky Blue
  DeliveryHeader: '#FFCC00', // Bright Yellow
  DeliveryItem: '#FFE680',   // Lighter Yellow
  BillingHeader: '#FF6600',  // Bright Orange
  BillingItem: '#FF994D',    // Lighter Orange
  BillingCancellation: '#E60000', // Pure Red
  Payment: '#00FF66',        // Spring Green
  JournalEntry: '#00B347',   // Darker Green
  Product: '#CC33FF',        // Bright Purple
  Plant: '#FFFFFF',          // Pure White
  Address: '#CCCCCC',        // Light Gray
  CustomerCompany: '#FF8099',
  CustomerSalesArea: '#FFB3C6',
  ProductPlant: '#E680FF',
  ScheduleLine: '#CCE6FF',
  ProductDescription: '#D966FF',
  ProductStorageLocation: '#E6E6E6',
};
