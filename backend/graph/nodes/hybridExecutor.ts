import type { O2CGraphState } from '../state.js';
import type { FunctionResult } from '../../types/index.js';
import { callLLM } from '../../services/llm.js';
import { runQuery } from '../../db.js';
import { validateCypher, enforceSizeLimit } from './guardrail.js';
import { retrieveContext } from '../../services/graphRAG.js';
import * as lookup from '../../functions/lookup.js';
import * as traverse from '../../functions/traverse.js';
import * as aggregate from '../../functions/aggregate.js';
import * as detect from '../../functions/detect.js';
import * as compare from '../../functions/compare.js';
import * as meta from '../../functions/meta.js';

// Map function names to actual implementations
const FUNCTION_MAP: Record<string, (...args: unknown[]) => Promise<FunctionResult>> = {
  getCustomer: (p: unknown) => lookup.getCustomer((p as Record<string, string>).customerId),
  getOrder: (p: unknown) => lookup.getOrder((p as Record<string, string>).orderId),
  getProduct: (p: unknown) => lookup.getProduct((p as Record<string, string>).productId),
  getBillingDoc: (p: unknown) => lookup.getBillingDoc((p as Record<string, string>).billingDocId),
  getDelivery: (p: unknown) => lookup.getDelivery((p as Record<string, string>).deliveryId),
  traceDocument: (p: unknown) => traverse.traceDocument((p as Record<string, string>).billingDocId),
  getOrderDeliveries: (p: unknown) => traverse.getOrderDeliveries((p as Record<string, string>).orderId),
  getDeliveryBilling: (p: unknown) => traverse.getDeliveryBilling((p as Record<string, string>).deliveryId),
  traceOrderJourney: (p: unknown) => traverse.traceOrderJourney((p as Record<string, string>).orderId),
  compareCustomerRevenue: (p: unknown) => compare.compareCustomerRevenue((p as Record<string, string>).customerId1, (p as Record<string, string>).customerId2),
  compareCustomerOrders: (p: unknown) => compare.compareCustomerOrders((p as Record<string, string>).customerId1, (p as Record<string, string>).customerId2),
  getEntityTypesSummary: () => meta.getEntityTypesSummary(),
  getSalesOrderItemToDeliveryItemJoinInfo: () => meta.getSalesOrderItemToDeliveryItemJoinInfo(),
  getBusinessPartnerToBillingDocumentPath: () => meta.getBusinessPartnerToBillingDocumentPath(),
  getDeliveryGoodsMovementStatusCounts: () => meta.getDeliveryGoodsMovementStatusCounts(),
  traceSalesOrderToDeliveryAndBilling: (p: unknown) => meta.traceSalesOrderToDeliveryAndBilling((p as Record<string, string>).orderId),
  getBillingItemsReferencingDelivery: (p: unknown) => meta.getBillingItemsReferencingDelivery((p as Record<string, string>).deliveryId),
  getProductsWithMaxPlantCoverage: () => meta.getProductsWithMaxPlantCoverage(),
  getCustomerBilledVsPaidBalance: (p: unknown) => meta.getCustomerBilledVsPaidBalance((p as Record<string, string>).customerId),
  getPaymentsCollectedThisMonth: () => meta.getPaymentsCollectedThisMonth(),
  getDeliveriesNotBilled: () => meta.getDeliveriesNotBilled(),
  getOrderToPaymentCycleTime: () => meta.getOrderToPaymentCycleTime(),
  getPaymentsWithoutJournalEntries: () => meta.getPaymentsWithoutJournalEntries(),
  getPaymentsCollectedLastMonth: () => meta.getPaymentsCollectedLastMonth(),
  getSalesRevenueLastMonth: () => meta.getSalesRevenueLastMonth(),
  getOrdersPlacedByCustomer: (p: unknown) => meta.getOrdersPlacedByCustomer((p as Record<string, string>).customerId),
  getProductsStoredInPlant: (p: unknown) => meta.getProductsStoredInPlant((p as Record<string, string>).plantId),
  getCancelledInvoicesSummary: () => meta.getCancelledInvoicesSummary(),
  getO2CGraphSchemaDesign: () => meta.getO2CGraphSchemaDesign(),
  analyzeBillingCancellationAnomaly: () => meta.analyzeBillingCancellationAnomaly(),
  getProfitCenterToProductsTrace: () => meta.getProfitCenterToProductsTrace(),
  getTopProducts: (p: unknown) => {
    const params = p as Record<string, string>;
    return aggregate.getTopProducts(params.metric ?? 'billing', Number(params.limit) || 10);
  },
  getTopCustomers: (p: unknown) => {
    const params = p as Record<string, string>;
    return aggregate.getTopCustomers(params.metric ?? 'orders', Number(params.limit) || 10);
  },
  getOrdersByOrg: (p: unknown) => {
    const params = p as Record<string, string>;
    return aggregate.getOrdersByOrg(params.orgId || null);
  },
  getRevenueConcentration: () => aggregate.getRevenueConcentration(),
  getActiveBillingTotals: () => aggregate.getActiveBillingTotals(),
  getTopActiveBillingMonthRevenue: () => aggregate.getTopActiveBillingMonthRevenue(),
  getTopDeliveriesByProductCount: (p: unknown) => aggregate.getTopDeliveriesByProductCount(Number((p as Record<string, string>).limit) || 10),
  findBrokenFlows: (p: unknown) => detect.findBrokenFlows((p as Record<string, string>).type ?? 'undelivered'),
  getUnpaidInvoices: (p: unknown) => detect.getUnpaidInvoices(Number((p as Record<string, string>).limit) || 10),
  getCancelledDocs: (p: unknown) => detect.getCancelledDocs(Number((p as Record<string, string>).limit) || 10),
  getCustomerBillingSummary: (p: unknown) => detect.getCustomerBillingSummary((p as Record<string, string>).customerId),
  getCancelledAfterPayment: () => detect.getCancelledAfterPayment(),
  getCustomersWithoutBilling: () => detect.getCustomersWithoutBilling(),
  getProductsNeverDelivered: () => detect.getProductsNeverDelivered(),
  getFullAnomalyReport: () => detect.getFullAnomalyReport(),
  getDeliveryFulfillmentRate: () => detect.getDeliveryFulfillmentRate(),
  getMostExpensiveBillingItem: () => detect.getMostExpensiveBillingItem(),
  getJournalEntryDistribution: () => detect.getJournalEntryDistribution(),
  getPaymentClearingTime: () => detect.getPaymentClearingTime(),
  getPaymentTermsSplit: () => detect.getPaymentTermsSplit(),
  getBillingDocTypeBreakdown: () => detect.getBillingDocTypeBreakdown(),
  getPlantRevenueRanking: () => detect.getPlantRevenueRanking(),
  getUnpaidActiveBillingDocs: () => detect.getUnpaidActiveBillingDocs(),
  getSystemPipelineDescription: (p: unknown) => {
    const params = p as Record<string, string>;
    return meta.getSystemPipelineDescription(params.mentionedQuery, params.entities ? JSON.parse(params.entities) : undefined);
  },
};

// ── CYPHER REASONING EXTRACTOR ────────────────────────────────────────────────
// Parses LLM response that may contain both reasoning and cypher in JSON format.
interface CypherGenResult {
  cypher: string;
  reasoning: string | null;
}

function extractCypherFromResponse(responseText: string): CypherGenResult {
  // Attempt 1: Parse as structured JSON { reasoning, cypher }
  try {
    const parsed = JSON.parse(responseText) as {
      cypher?: string;
      reasoning?: string;
    };
    if (parsed.cypher) {
      return {
        cypher: parsed.cypher,
        reasoning: parsed.reasoning ?? null,
      };
    }
  } catch {
    // Not valid JSON — try fallback extraction
  }

  // Attempt 2: Extract JSON block from mixed response
  const jsonMatch = responseText.match(/\{[\s\S]*?"cypher"\s*:\s*"[\s\S]*?"\s*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { cypher?: string; reasoning?: string };
      if (parsed.cypher) {
        return { cypher: parsed.cypher, reasoning: parsed.reasoning ?? null };
      }
    } catch {
      // JSON extraction failed
    }
  }

  // Attempt 3: Extract raw MATCH...RETURN from response text
  const cypherMatch = responseText.match(/MATCH[\s\S]+?(?:RETURN|LIMIT)[\s\S]*$/im);
  if (cypherMatch) {
    return { cypher: cypherMatch[0], reasoning: null };
  }

  throw new Error('Could not extract Cypher from LLM response');
}


export async function hybridExecutor(
  state: O2CGraphState
): Promise<Partial<O2CGraphState>> {

  // PATH A: Function execution
  if (state.pathTaken === 'function' && state.selectedFunction) {
    const fn = FUNCTION_MAP[state.selectedFunction.name];
    if (fn) {
      try {
        const result = await fn(state.selectedFunction.params);
        if (result.records.length === 0 && state.retryCount < 3) {
          return {
            retryCount: state.retryCount + 1,
            queryError: 'No results found',
          };
        }
        return {
          queryResults: result.records,
          confidence: 'high',
          queryError: null,
        };
      } catch (err: unknown) {
        if (state.retryCount < 3) {
          return {
            retryCount: state.retryCount + 1,
            queryError: err instanceof Error ? err.message : 'Function execution failed',
          };
        }
        return {
          answer: "I wasn't able to find reliable data for this. Try rephrasing with a specific ID or entity name.",
          confidence: 'low',
        };
      }
    } else {
      // Function not found in FUNCTION_MAP (likely functionName is null).
      // Fall through to dynamic Cypher generation — mark path accordingly
      // so the contract verifier knows NOT to check field names.
      console.log(`  [Executor] Function "${state.selectedFunction.name}" not in FUNCTION_MAP — falling through to Cypher generation`);
      state = { ...state, pathTaken: 'template' };
    }
  }

  // PATH B & C: Template / Constrained Cypher generation with GraphRAG
  const isConstrained = state.pathTaken === 'constrained';
  const isRetry = state.retryCount > 0;
  const tier = isConstrained ? 3 : 2;

  // ── GraphRAG: Retrieve similar examples + targeted schema ──
  const ragContext = retrieveContext(state.resolvedMessage, 3);
  console.log(`  [GraphRAG] Using schema subset (${ragContext.matchedExamples.length} examples) instead of full 135-line schema`);

  // ── BUILD SYSTEM PROMPT ──
  // Base instructions (always included)
  let systemPrompt = `You are a Neo4j Cypher query composer for a SAP Order-to-Cash (O2C) graph database.
Given a user question, write a precise Cypher query that answers it correctly.

CYPHER RULES:
- ALLOWED operations: MATCH, WHERE, WITH, OPTIONAL MATCH, RETURN, ORDER BY, LIMIT, UNWIND, CASE WHEN, count(), sum(), avg(), min(), max(), collect(), size(), DISTINCT
- FORBIDDEN operations: CREATE, DELETE, SET, MERGE, DROP, DETACH, CALL, LOAD CSV, FOREACH, window functions (OVER clause)
- Always add LIMIT (max 50) to prevent huge result sets
- For aggregation queries (COUNT, SUM, etc.) — put LIMIT AFTER the aggregation, NOT before
- Never use window functions like ROW_NUMBER() OVER or any OVER() clause — Neo4j does not support them
- Use ORDER BY + LIMIT instead of window functions for ranking queries

FIELD TYPE HINTS (critical for correct Cypher):
- totalNetAmount, netAmount, amountInTransactionCurrency: These are STRING fields in Neo4j. You MUST use toFloat() before any arithmetic: sum(toFloat(x.totalNetAmount))
- businessPartnerIsBlocked, billingDocumentIsCancelled: These are BOOLEAN fields. Use = true or = false, NOT string comparison
- creationDate, billingDocumentDate, clearingDate, confirmedDeliveryDate: These are STRING dates stored as "YYYY-MM-DD" format.
  - To compare with today: use date(x.fieldName) = date() (converts string to date, then compares with today's date)
  - To compare with a specific date: use date(x.fieldName) >= date("2025-04-01")
  - NEVER use substring(date(), ...) — date() returns a Date object, NOT a string. Use toString(date()) if you need it as a string.
  - For date range filtering: WHERE date(x.creationDate) >= date("2025-04-01") AND date(x.creationDate) < date("2025-05-01")
  - For STARTS WITH on date strings: use x.creationDate STARTS WITH "2025-04" (compare string to string, do NOT mix with date())
- For date difference calculations: use duration.between(date(start), date(end)).days
- Customer ID links: Customer.id = SalesOrder.soldToParty = BillingHeader.soldToParty = Payment.customer
- There is NO direct relationship between Customer and BillingHeader — use property match: WHERE bh.soldToParty = c.id
- To join BillingHeader to Payment for clearing time: use Payment.accountingDocument = BillingHeader.accountingDocument
- DeliveryItem has NO material field. To get products: (SalesOrderItem)-[:FULFILLED_BY]->(DeliveryItem) then (SalesOrderItem)-[:REFERENCES]->(Product)
- REVENUE = active (non-cancelled) BillingHeader.totalNetAmount. NEVER use SalesOrder amounts for revenue
- For active (non-cancelled) billing: WHERE bh.billingDocumentIsCancelled = false OR bh.billingDocumentIsCancelled IS NULL

SIMILAR EXAMPLE QUERIES (adapt these patterns to the user's question):
${ragContext.fewShotExamples}

RELEVANT SCHEMA (ONLY use these node types and relationships):
${ragContext.schemaSubset}`;

  // ── CHAIN-OF-THOUGHT (only for constrained/novel or retry paths) ──
  // On normal template queries, CoT adds unnecessary tokens.
  // On constrained/retry, it dramatically improves accuracy.
  if (isConstrained || isRetry) {
    systemPrompt += `

MANDATORY REASONING (you MUST answer these questions before writing Cypher):
Before writing your Cypher query, think step-by-step:
1. WHAT does the user want? (What entity types, what metric, what filter?)
2. WHICH nodes and relationships are needed? (List the traversal path)
3. WHERE are the gotchas? (String amounts needing toFloat? Missing direct relationships? Boolean filters?)
4. HOW should results be aggregated? (COUNT vs SUM vs collect? GROUP BY pattern?)
5. WHAT should be returned? (Column names that make sense for the user's question)

Include your reasoning in the JSON response.`;
  }

  // ── SELF-CORRECTION GUIDANCE (only on retry) ──
  if (isRetry && state.queryError) {
    systemPrompt += `

SELF-CORRECTION — YOUR PREVIOUS QUERY FAILED:
Previous error: ${state.queryError}
${state.executedCypher ? `Failed Cypher: ${state.executedCypher}` : ''}

CORRECTION PROTOCOL:
1. DIAGNOSE: What exactly went wrong? (wrong property name? missing toFloat? wrong relationship direction? cartesian product?)
2. ROOT CAUSE: Is it a schema issue, a logic issue, or a syntax issue?
3. FIX STRATEGY: State specifically what you will change and why.
4. NEW APPROACH: Write a fundamentally different query — do NOT make the same mistake again.

Common fixes:
- "No results" usually means: wrong property name, wrong relationship direction, or too-restrictive WHERE clause
- "Type mismatch" usually means: forgot toFloat() on a string amount field
- "Unknown function" usually means: used a window function (OVER) — replace with ORDER BY + LIMIT
- "cartesian product" means: missing WHERE clause connecting nodes, add proper join conditions`;
  }

  // ── RESPONSE FORMAT ──
  systemPrompt += `

RESPONSE FORMAT — respond with ONLY valid JSON:
{
  "reasoning": "Step-by-step explanation of your query logic",
  "cypher": "MATCH (n:NodeType) WHERE ... RETURN ..."
}`;

  const userPrompt = `Question: "${state.resolvedMessage}"
Extracted entities: ${JSON.stringify(state.extractedEntities)}`;

  try {
    const response = await callLLM({
      systemPrompt,
      userPrompt,
      tier: tier as 1 | 2 | 3,
      maxTokens: isConstrained || isRetry ? 800 : 500,
      callerTag: `cypher-gen-t${tier}${isRetry ? '-retry' + state.retryCount : ''}`,
    });

    // ── EXTRACT CYPHER + REASONING ──
    const result = extractCypherFromResponse(response.text);

    // Log reasoning for audit trail
    if (result.reasoning) {
      console.log(`  [CypherGen] Reasoning: ${result.reasoning.substring(0, 200)}${result.reasoning.length > 200 ? '...' : ''}`);
    }

    const validation = validateCypher(result.cypher);
    if (!validation.valid) {
      console.log(`  [Executor] Cypher BLOCKED: ${validation.reason}`);
      if (state.retryCount < 3) {
        return {
          retryCount: state.retryCount + 1,
          queryError: `Generated Cypher blocked: ${validation.reason}`,
          executedCypher: result.cypher,
        };
      }
      return {
        answer: "I wasn't able to generate a safe query for this question. Please try rephrasing.",
        confidence: 'low',
      };
    }

    // Layer 5: Enforce size limit
    result.cypher = enforceSizeLimit(result.cypher);

    console.log(`  [Executor] Generated Cypher: ${result.cypher}`);
    const records = await runQuery(result.cypher, {});

    if (records.length === 0 && state.retryCount < 3) {
      return {
        retryCount: state.retryCount + 1,
        queryError: `Query returned 0 results. The query was: ${result.cypher}`,
        executedCypher: result.cypher,
      };
    }

    return {
      queryResults: records,
      confidence: isConstrained ? 'low' : 'medium',
      queryError: null,
      usedFallback: response.usedFallback,
      executedCypher: result.cypher,
    };
  } catch (err: unknown) {
    if (state.retryCount < 3) {
      return {
        retryCount: state.retryCount + 1,
        queryError: err instanceof Error ? err.message : 'Query generation failed',
      };
    }
    return {
      answer: "I wasn't able to find reliable data for this. Try rephrasing with a specific ID or entity name.",
      confidence: 'low',
    };
  }
}
