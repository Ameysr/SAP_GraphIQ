import type { O2CGraphState } from '../state.js';
import { callLLM } from '../../services/llm.js';
import { FUNCTION_REGISTRY } from '../../functions/index.js';

// ── SYNONYM EXPANSION MAP ─────────────────────────────────────────────────────
// Maps common user phrases to canonical SAP O2C terms.
// Applied BEFORE entity matching to normalize vocabulary mismatch.
const SYNONYM_MAP: Record<string, string> = {
  // Billing synonyms
  'invoice': 'billing document',
  'invoices': 'billing documents',
  'bill': 'billing document',
  'bills': 'billing documents',
  'receipt': 'billing document',
  'receipts': 'billing documents',
  // Payment synonyms
  'paid': 'payment',
  'pay': 'payment',
  'settled': 'payment',
  'cleared': 'payment clearing',
  'collection': 'payment',
  // Delivery synonyms
  'shipment': 'delivery',
  'shipments': 'deliveries',
  'shipped': 'delivered',
  'dispatch': 'delivery',
  'dispatched': 'delivered',
  'outbound': 'delivery',
  // Order synonyms
  'purchase order': 'sales order',
  'PO': 'sales order',
  'SO': 'sales order',
  // Customer synonyms
  'buyer': 'customer',
  'client': 'customer',
  'account': 'customer',
  'business partner': 'customer',
  'BP': 'customer',
  // Revenue synonyms
  'income': 'revenue',
  'earnings': 'revenue',
  'sales': 'revenue',
  'turnover': 'revenue',
  // Status synonyms
  'outstanding': 'unpaid',
  'overdue': 'unpaid',
  'pending': 'unpaid',
  'open': 'unpaid',
  // Anomaly synonyms
  'issue': 'anomaly',
  'problem': 'anomaly',
  'exception': 'anomaly',
  'error': 'anomaly',
  'discrepancy': 'anomaly',
  // Cancel synonyms
  'reversed': 'cancelled',
  'voided': 'cancelled',
  'credit memo': 'cancellation',
  'credit note': 'cancellation',
  // Plant/warehouse synonyms
  'warehouse': 'plant',
  'facility': 'plant',
  'location': 'plant',
  // Product synonyms
  'item': 'product',
  'material': 'product',
  'SKU': 'product',
  'goods': 'product',
  // Financial synonyms
  'AR': 'accounts receivable',
  'DSO': 'days sales outstanding',
  'aging': 'AR aging',
};

/**
 * Apply synonym expansion to normalize user vocabulary.
 * Uses word-boundary matching to avoid partial replacements.
 */
function expandSynonyms(message: string): string {
  let expanded = message;
  for (const [synonym, canonical] of Object.entries(SYNONYM_MAP)) {
    // Word-boundary match, case-insensitive
    const regex = new RegExp(`\\b${synonym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (regex.test(expanded)) {
      expanded = expanded.replace(regex, canonical);
    }
  }
  return expanded;
}

// ── ACCURACY LOGGER ───────────────────────────────────────────────────────────
function logFunctionSelection(
  question: string,
  selected: string | null,
  path: string,
  intent: string,
  confidence?: number,
  reasoning?: string
): void {
  const timestamp = new Date().toISOString();
  console.log(`  [AccuracyLog] ${timestamp} | intent=${intent} | path=${path} | fn=${selected ?? 'none'} | conf=${confidence?.toFixed(2) ?? 'n/a'} | q="${question.substring(0, 60)}"`);
  if (reasoning) {
    console.log(`  [AccuracyLog]   reasoning: ${reasoning.substring(0, 120)}`);
  }
}

// ── CONFIDENCE THRESHOLD ──────────────────────────────────────────────────────
const CONFIDENCE_THRESHOLD = 0.7;

/**
 * UNIFIED Function Selector (optimized + enhanced).
 *
 * Routing priority:
 * 1. Plan routing (question_plans.json) — handled BEFORE this node in index.ts
 *    If a plan locked a function, this node is skipped entirely.
 *
 * 2. Entity-specific lookups (deterministic, 0 LLM calls)
 *    If entities were extracted and intent is clear, route directly.
 *    Synonym expansion is applied first to normalize vocabulary.
 *
 * 3. LLM function selection with confidence scoring (last resort, 1 LLM call)
 *    Ask LLM to pick from the function list with few-shot examples.
 *    If confidence < 0.7, fallback to template path (dynamic Cypher).
 */
export async function functionSelector(
  state: O2CGraphState
): Promise<Partial<O2CGraphState>> {
  // UNKNOWN skips function selection
  if (state.intentType === 'UNKNOWN' || state.intentType === '') {
    return {};
  }

  const intent = state.intentType;
  const functions = FUNCTION_REGISTRY[intent] ?? [];
  const allFunctions = Object.values(FUNCTION_REGISTRY).flat();

  if (allFunctions.length === 0) {
    return { pathTaken: 'template' };
  }

  // ── SYNONYM EXPANSION ──────────────────────────────────────────────────────
  // Normalize user vocabulary before matching.
  // "Show me all unpaid invoices" -> "Show me all unpaid billing documents"
  const expandedMessage = expandSynonyms(state.resolvedMessage);
  const lower = expandedMessage.toLowerCase();
  const entities = state.extractedEntities;

  if (expandedMessage !== state.resolvedMessage) {
    console.log(`  [FuncSelector] Synonym expansion: "${state.resolvedMessage.substring(0, 60)}" -> "${expandedMessage.substring(0, 60)}"`);
  }

  // ── ENTITY-SPECIFIC LOOKUPS (deterministic, 0 LLM calls) ──────────────────
  // These are unambiguous: entity ID + context keyword = exact function.

  // Billing doc lookup — priority over billing summary
  if (entities.BillingHeader && (lower.includes('detail') || lower.includes('what is') || lower.includes('show') || lower.includes('look') || lower.includes('full detail') || lower.includes('billing document'))) {
    const fn = allFunctions.find(f => f.name === 'getBillingDoc');
    if (fn) {
      console.log(`  [FuncSelector] Entity match -> getBillingDoc(${entities.BillingHeader})`);
      logFunctionSelection(state.resolvedMessage, 'getBillingDoc', 'entity-match', intent, 1.0);
      return {
        selectedFunction: { name: 'getBillingDoc', params: { billingDocId: entities.BillingHeader } },
        pathTaken: 'function',
      };
    }
  }

  // Customer billing summary — customer ID + billing/financial keywords
  const mentionsCustomer = entities.Customer && (lower.includes(entities.Customer.toLowerCase()) || lower.includes('customer'));
  if (mentionsCustomer && (lower.includes('billing') || lower.includes('financial') || lower.includes('billing document') || lower.includes('unpaid') || lower.includes('summary'))) {
    const fn = allFunctions.find(f => f.name === 'getCustomerBillingSummary');
    if (fn) {
      console.log(`  [FuncSelector] Entity match -> getCustomerBillingSummary(${entities.Customer})`);
      logFunctionSelection(state.resolvedMessage, 'getCustomerBillingSummary', 'entity-match', intent, 1.0);
      return {
        selectedFunction: { name: 'getCustomerBillingSummary', params: { customerId: entities.Customer } },
        pathTaken: 'function',
      };
    }
  }

  // Order journey trace — sales order + trace/journey keywords
  if (entities.SalesOrder && (lower.includes('trace') || lower.includes('journey') || lower.includes('complete') || lower.includes('full cycle') || lower.includes('end to end'))) {
    const fn = allFunctions.find(f => f.name === 'traceOrderJourney');
    if (fn) {
      console.log(`  [FuncSelector] Entity match -> traceOrderJourney(${entities.SalesOrder})`);
      logFunctionSelection(state.resolvedMessage, 'traceOrderJourney', 'entity-match', intent, 1.0);
      return {
        selectedFunction: { name: 'traceOrderJourney', params: { orderId: entities.SalesOrder } },
        pathTaken: 'function',
      };
    }
  }

  // Simple entity lookups by intent
  if (intent === 'LOOKUP') {
    if (entities.Customer && (lower.includes('order') || lower.includes('orders') || lower.includes('placed'))) {
      const fn = allFunctions.find((f) => f.name === 'getOrdersPlacedByCustomer');
      if (fn) {
        console.log(`  [FuncSelector] Keyword match → getOrdersPlacedByCustomer(${entities.Customer})`);
        return {
          selectedFunction: { name: 'getOrdersPlacedByCustomer', params: { customerId: entities.Customer } },
          pathTaken: 'function',
        };
      }
    }
    if (entities.Plant && (lower.includes('product') || lower.includes('products')) && (lower.includes('plant') || lower.includes('in plant') || lower.includes('stored'))) {
      const fn = allFunctions.find((f) => f.name === 'getProductsStoredInPlant');
      if (fn) {
        console.log(`  [FuncSelector] Keyword match → getProductsStoredInPlant(${entities.Plant})`);
        return {
          selectedFunction: { name: 'getProductsStoredInPlant', params: { plantId: entities.Plant } },
          pathTaken: 'function',
        };
      }
    }

    if (entities.Customer) {
      logFunctionSelection(state.resolvedMessage, 'getCustomer', 'entity-lookup', intent, 1.0);
      return {
        selectedFunction: { name: 'getCustomer', params: { customerId: entities.Customer } },
        pathTaken: 'function',
      };
    }
    if (entities.SalesOrder) {
      logFunctionSelection(state.resolvedMessage, 'getOrder', 'entity-lookup', intent, 1.0);
      return {
        selectedFunction: { name: 'getOrder', params: { orderId: entities.SalesOrder } },
        pathTaken: 'function',
      };
    }
    if (entities.Product) {
      logFunctionSelection(state.resolvedMessage, 'getProduct', 'entity-lookup', intent, 1.0);
      return {
        selectedFunction: { name: 'getProduct', params: { productId: entities.Product } },
        pathTaken: 'function',
      };
    }
  }

  // ── LLM FUNCTION SELECTION (last resort, 1 LLM call) ──────────────────────
  // Enhanced with: few-shot examples, confidence scoring, reasoning audit trail
  const funcListStr = functions
    .map((f) => `- ${f.name}(${Object.entries(f.params).map(([k, v]) => `${k}: ${v}`).join(', ')}): ${f.description}`)
    .join('\n');

  const systemPrompt = `You are a function router for a SAP Order-to-Cash (O2C) graph intelligence system.
Your job: given a user question, decide which function to call from the available list.

AVAILABLE FUNCTIONS:
${funcListStr}

RESPONSE FORMAT — respond with ONLY this JSON, nothing else:
{
  "matched": true,
  "function": "functionName",
  "params": { "paramName": "value" },
  "confidence": 0.95,
  "reasoning": "Brief explanation of why this function matches"
}
OR if no function matches:
{
  "matched": false,
  "confidence": 0.0,
  "reasoning": "No function handles this type of query because..."
}

FEW-SHOT EXAMPLES:

Q: "Which customers have the highest revenue?"
A: { "matched": true, "function": "getTopCustomers", "params": { "metric": "revenue", "limit": "10" }, "confidence": 0.95, "reasoning": "Revenue ranking by customer = getTopCustomers with metric=revenue" }

Q: "Show me the billing details for document 91150188"
A: { "matched": true, "function": "getBillingDoc", "params": { "billingDocId": "91150188" }, "confidence": 0.98, "reasoning": "Specific billing document lookup by ID" }

Q: "Find all orders that were never delivered"
A: { "matched": true, "function": "findBrokenFlows", "params": { "type": "undelivered" }, "confidence": 0.92, "reasoning": "Orders with no delivery = broken flow detection, type=undelivered" }

Q: "What products are ordered by only one customer?"
A: { "matched": false, "confidence": 0.0, "reasoning": "No function handles single-customer product analysis. This needs dynamic Cypher." }

Q: "What is the average DSO per customer?"
A: { "matched": false, "confidence": 0.0, "reasoning": "No function computes Days Sales Outstanding. This requires a custom Cypher query with date calculations." }

RULES:
- confidence must be between 0.0 and 1.0
- Set confidence >= 0.9 only when the function EXACTLY matches the question intent
- Set confidence 0.7-0.89 when the function partially matches (e.g., correct entity type but slightly different analysis)
- Set confidence < 0.7 when unsure — the system will safely fallback to dynamic Cypher generation
- If the question asks for something NO function covers (e.g., custom date analysis, multi-hop traversals not in the list), return matched: false
- Do NOT force-match a function that does not truly answer the question — false matches are worse than no match
- The reasoning field is logged for audit — be specific about WHY you chose this function`;

  const entitiesStr = Object.entries(state.extractedEntities)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  const userPrompt = `Question: "${expandedMessage}"
Original question: "${state.resolvedMessage}"
Detected intent: ${state.intentType}
Extracted entities: ${entitiesStr || 'none'}`;

  try {
    const response = await callLLM({
      systemPrompt,
      userPrompt,
      tier: Math.min(state.tierToUse, 2) as 1 | 2 | 3,
      maxTokens: 250,
      callerTag: 'func-selector',
    });

    console.log(`  [FuncSelector] LLM response: ${response.text}`);

    try {
      const parsed = JSON.parse(response.text) as {
        matched: boolean;
        function?: string;
        params?: Record<string, unknown>;
        confidence?: number;
        reasoning?: string;
      };

      const confidence = parsed.confidence ?? 0.5;
      const reasoning = parsed.reasoning ?? '';

      // ── CONFIDENCE THRESHOLD CHECK ──
      if (parsed.matched && parsed.function && confidence >= CONFIDENCE_THRESHOLD) {
        const validFunc = functions.find((f: { name: string }) => f.name === parsed.function);
        if (validFunc) {
          logFunctionSelection(state.resolvedMessage, parsed.function, 'function/llm', state.intentType, confidence, reasoning);
          return {
            selectedFunction: { name: parsed.function, params: parsed.params ?? {} },
            pathTaken: 'function',
            usedFallback: response.usedFallback,
          };
        } else {
          // LLM selected a function that doesn't exist in the registry
          console.log(`  [FuncSelector] LLM selected invalid function "${parsed.function}" — falling back to template`);
          logFunctionSelection(state.resolvedMessage, null, 'template/invalid-func', state.intentType, confidence, reasoning);
          return { pathTaken: 'template', usedFallback: response.usedFallback };
        }
      }

      // ── LOW CONFIDENCE FALLBACK ──
      if (parsed.matched && parsed.function && confidence < CONFIDENCE_THRESHOLD) {
        console.log(`  [FuncSelector] Low confidence (${confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}) — falling back to dynamic Cypher for better accuracy`);
        logFunctionSelection(state.resolvedMessage, parsed.function, 'template/low-confidence', state.intentType, confidence, reasoning);
        return { pathTaken: 'template', usedFallback: response.usedFallback };
      }

      logFunctionSelection(state.resolvedMessage, null, 'template/llm-nomatch', state.intentType, confidence, reasoning);
      return { pathTaken: 'template', usedFallback: response.usedFallback };
    } catch {
      logFunctionSelection(state.resolvedMessage, null, 'template/parse-error', state.intentType);
      return { pathTaken: 'template' };
    }
  } catch {
    logFunctionSelection(state.resolvedMessage, null, 'template/llm-error', state.intentType);
    return { pathTaken: 'template' };
  }
}
