import type { O2CGraphState } from '../state.js';
import { callLLM } from '../../services/llm.js';
import { saveHistory, saveEntities } from '../../services/memory.js';
import { saveToCache } from '../../services/semanticCache.js';
import { log } from '../../services/logger.js';
import type { Confidence, ObservabilityLog } from '../../types/index.js';

export async function answerFormatter(
  state: O2CGraphState
): Promise<Partial<O2CGraphState>> {
  // If answer is already set (guardrail rejection or retry exhaustion), skip
  if (state.answer) {
    const latencyMs = Date.now() - state.startTime;

    // Log observability
    await logObservability(state, latencyMs);
    return { latencyMs };
  }

  // If no query results, return context-aware fallback
  if (!state.queryResults || state.queryResults.length === 0) {
    const msg = state.resolvedMessage.toLowerCase();
    let answer: string;

    // Date-based query with no results — explain the date range
    if (/today|yesterday|this week|this month|last month|last week/i.test(msg)) {
      const today = new Date().toISOString().slice(0, 10);
      answer = `No matching records found for the requested time period (searched as of ${today}). The dataset may not contain data for this date range — the SAP O2C data primarily covers April 2025. Try asking about a specific date range, e.g., "deliveries in April 2025."`;
    }
    // Entity-specific query with no results
    else if (Object.keys(state.extractedEntities).length > 0) {
      const entityStr = Object.entries(state.extractedEntities)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      answer = `No matching records found for ${entityStr}. Please verify the ID exists in the system, or try a different identifier.`;
    }
    // General no-results
    else {
      answer = `No matching records found for this query. The question may require data that isn't in the current dataset, or the search criteria may be too specific. Try broadening your question or using a known entity ID.`;
    }

    const latencyMs = Date.now() - state.startTime;
    await logObservability(state, latencyMs);
    return { answer, confidence: 'low', latencyMs, nodesReferenced: [] };
  }

  // Pass results to LLM — show up to 50 records but ALWAYS pass the TOTAL count
  const totalRecordCount = state.queryResults.length;
  const trimmedResults = state.queryResults.slice(0, 50);

  const routingTrace = state.routingTrace;
  const selectedFunctionName = state.selectedFunction?.name ?? '';
  const contractVerified = routingTrace?.contractVerified ?? null;
  const contractReason = routingTrace?.contractReason ?? null;
  const plansTried = routingTrace?.plansTried ?? [];
  const activePlanId = routingTrace?.activePlanId ?? null;

  // ── FUNCTION-NAME SCHEMA HINTS ──────────────────────────────────────────────
  // When a function is selected, tell the LLM exactly what fields to expect.
  // This replaces sending full schema context, reducing prompt size by ~50%.
  const FUNCTION_CONTEXT_HINTS: Record<string, string> = {
    getPlantRevenueRanking: 'Plant revenue ranked by BillingHeader totals. Fields: plantId, plantName, totalBilledRevenue (INR currency), billingDocCount (count, NOT currency), deliveryItemCount (count, NOT currency), currency.',
    getActiveBillingTotals: 'Active (non-cancelled) billing document summary. Fields: activeDocs, totalDocs, activePercentage (0-100), activeTotalNetAmount (INR currency), currency.',
    getTopActiveBillingMonthRevenue: 'Top month by active billing revenue. Fields: month, activeRevenueAmount (INR currency), activeRevenuePercentage (0-100), activeRevenueTotal (INR currency), currency.',
    getRevenueConcentration: 'Revenue concentration by customer. Fields: customer, customerId, revenue (INR currency), percentage (0-100), currency.',
    getDeliveryFulfillmentRate: 'Delivery fulfillment rate per customer. Fields: customer, customerId, totalItems, deliveredItems, fulfillmentRate (0-100), orderIds.',
    getFullAnomalyReport: 'Complete O2C anomaly report. Multiple anomaly categories with counts and details.',
    getEntityTypesSummary: 'Graph entity type summary. Fields: entityTypeCount, entityTypes (list), excludedTypes.',
    getPaymentClearingTime: 'Invoice-to-payment clearing duration. Fields: billingDocument, billingDate, clearingDate, daysToClear.',
    getJournalEntryDistribution: 'Journal entries per customer. Fields: customer, totalEntries, positiveEntries, negativeEntries, netAmount.',
    getCustomerBillingSummary: 'Customer billing profile. Fields: totalDocs, activeDocs, cancelledDocs, totalActiveAmount, paidDocs, unpaidDocs, unpaidAmount.',
    traceOrderJourney: 'Full O2C journey for a sales order. Fields: salesOrderItem, product, deliveryDocument, billingDocument, paymentStatus.',
    getUnpaidActiveBillingDocs: 'Unpaid active billing documents. Fields: unpaidCount, totalOutstandingAmount, currency, customerBreakdown.',
    getBillingDocTypeBreakdown: 'Billing document type breakdown. Fields: billingDocumentType, totalCount, cancelledCount, totalNetAmount.',
  };

  const functionHint = selectedFunctionName ? (FUNCTION_CONTEXT_HINTS[selectedFunctionName] ?? '') : '';

  const firstRow = state.queryResults[0] ?? {};
  const rowKeys = Object.keys(firstRow);
  const amountFields: string[] = (() => {
    if (selectedFunctionName === 'getPlantRevenueRanking') return ['totalBilledRevenue'];
    if (selectedFunctionName === 'getActiveBillingTotals') return ['activeTotalNetAmount'];
    if (selectedFunctionName === 'getTopActiveBillingMonthRevenue') return ['activeRevenueAmount', 'activeRevenueTotal'];
    return rowKeys.filter((k) => /(amount|revenue|netamount|totalnetamount|totalbilledrevenue)/i.test(k));
  })();

  const amountFieldsStr = amountFields.length > 0 ? amountFields.join(', ') : 'NONE_DETECTED';
  // Context feeding optimization: compact payload to reduce tokens.
  // 1) remove null/undefined fields
  // 2) avoid pretty-print whitespace
  const compactResults = trimmedResults.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v === null || v === undefined) continue;
      out[k] = v;
    }
    return out;
  });

  let resultsStr = JSON.stringify(compactResults);
  if (resultsStr.length > 4000) {
    resultsStr = resultsStr.substring(0, 4000) + '\n... (truncated)';
  }

  // ── RESULT VALIDATION ──
  // Check if the query results match what the user asked about
  const resultKeys = totalRecordCount > 0 ? Object.keys(state.queryResults[0]) : [];
  const question = state.resolvedMessage.toLowerCase();
  let validationWarning = '';
  
  // Detect structural mismatch: asked about A but got B
  if (question.includes('plant') && !resultKeys.some(k => /plant/i.test(k))) {
    validationWarning = '\n⚠️ WARNING: The query results do NOT contain plant data. The query may have been incorrect.';
  }
  if (question.includes('product') && !resultKeys.some(k => /product|material/i.test(k))) {
    validationWarning = '\n⚠️ WARNING: The query results do NOT contain product data. The query may have been incorrect.';
  }
  if ((question.includes('billing type') || question.includes('document type')) && !resultKeys.some(k => /type/i.test(k))) {
    validationWarning = '\n⚠️ WARNING: The query results do NOT contain type data. The query may have been incorrect.';
  }
  // Check for null-only results (query ran but returned meaningless data)
  if (totalRecordCount > 0) {
    const firstResult = state.queryResults[0];
    const allNullKeys = Object.entries(firstResult).filter(([, v]) => v === null || v === undefined);
    if (allNullKeys.length > Object.keys(firstResult).length / 2) {
      validationWarning = '\n⚠️ WARNING: Most fields in the results are NULL — the query may be using wrong property names.';
    }
  }

  const systemPrompt = `You are a business data analyst. Given raw Neo4j query results from a SAP Order-to-Cash graph,
write a clear, comprehensive natural language answer.

TRUSTED DECISION TRAIL (do not ignore):
- pathTaken: ${state.pathTaken}
- selectedFunction: ${selectedFunctionName || 'none'}
- activePlanId: ${activePlanId ?? 'none'}
- contractVerified: ${contractVerified === null ? 'unknown' : String(contractVerified)}
- contractReason: ${contractReason ?? 'none'}
- plansTried: [${plansTried.join(', ')}]
${functionHint ? `\nFUNCTION CONTEXT: ${functionHint}` : ''}

CRITICAL RULES:
- The TOTAL record count is ${totalRecordCount}. ALWAYS use this number, do NOT count the sample records yourself.
- ALWAYS list entity names and IDs when available (customer names, order IDs, product names, etc.)
- Extract any node IDs (order numbers, billing docs, delivery IDs, customer IDs) and list them in nodesReferenced
- Use the productDescription field when available instead of raw material codes
- Format amounts with their currency (e.g. "INR 1,234.56")
- IMPORTANT: Do NOT invent or recompute numbers that are already present in the query results. Use the numeric fields from the results as the source of truth.
- Contract gating:
  - If contractVerified=true: you MUST NOT recompute, derive, or replace numeric values. Use numeric fields exactly as provided.
  - If contractVerified is not true/unknown: still do not invent numbers; use query result numeric fields.
- If aggregating amounts, compute from ALL records shown, not just a subset
- Give a COMPLETE answer — include all relevant details from the data, don't just summarize counts
- If a validation warning is present, mention it transparently in your answer
- FORMATTING: Use clean Markdown for readability. Use **bold** for key labels and important values, numbered lists (1. 2. 3.) or bullet points (- item) for multiple data points, and separate sections with line breaks. Keep it concise but well-structured. Do NOT use headers (#). Do NOT use code blocks.
- Currency formatting scope:
  - Format amounts with currency ONLY for these fields: ${amountFieldsStr}
  - Do NOT format count fields (e.g. billingDocCount, deliveryItemCount, totalDocs, activeDocs) as currency.
- Function-specific guard:
  - If selectedFunction is "getPlantRevenueRanking": total billed revenue MUST come from totalBilledRevenue + currency. billingDocCount and deliveryItemCount are counts, not INR amounts.
- Respond ONLY with JSON: { "answer": "string", "nodesReferenced": ["id1", "id2"] }${validationWarning}`;

  const userPrompt = `User question: "${state.resolvedMessage}"
TOTAL records found: ${totalRecordCount}
Query results (showing ${trimmedResults.length} of ${totalRecordCount} records):
${resultsStr}
`;

  let answer = '';
  let nodesReferenced: string[] = [];
  let confidence: Confidence = state.confidence || 'medium';
  let usedFallback = state.usedFallback;

  try {
    const response = await callLLM({
      systemPrompt,
      userPrompt,
      tier: 2,
      maxTokens: 1000,
      callerTag: 'answer-formatter',
    });

    usedFallback = usedFallback || response.usedFallback;

    try {
      const parsed = JSON.parse(response.text) as { answer: string; nodesReferenced: string[] };
      answer = parsed.answer;
      nodesReferenced = parsed.nodesReferenced ?? [];
    } catch {
      // Retry once
      try {
        const retry = await callLLM({
          systemPrompt: systemPrompt + '\nRESPOND WITH ONLY VALID JSON.',
          userPrompt,
          tier: 2,
          maxTokens: 1000,
          callerTag: 'answer-formatter-retry',
        });
        const parsed = JSON.parse(retry.text) as { answer: string; nodesReferenced: string[] };
        answer = parsed.answer;
        nodesReferenced = parsed.nodesReferenced ?? [];
        usedFallback = usedFallback || retry.usedFallback;
      } catch {
        // Fallback: use raw data summary
        answer = `Found ${trimmedResults.length} record(s). Here's the raw data: ${resultsStr.substring(0, 500)}`;
        nodesReferenced = [];
      }
    }
  } catch {
    answer = `Found ${trimmedResults.length} record(s) but couldn't format the answer. Try asking a simpler question.`;
    nodesReferenced = [];
  }

  // Clean up: only strip headers (h1-h6) to keep markdown concise
  answer = answer
    .replace(/^#{1,6}\s+/gm, '') // strip headers — use bold instead
    .trim();

  // Append disclaimer for low confidence
  if (confidence === 'low') {
    answer += ' (Note: this answer was dynamically generated — please verify against source data)';
  }

  const latencyMs = Date.now() - state.startTime;

  // Save to memory and cache
  try {
    const shouldSemanticCache =
      state.answer &&
      state.queryResults?.length > 0 &&
      (routingTrace?.contractVerified === true || routingTrace?.activePlanCritical === true);

    await Promise.all([
      saveHistory(state.sessionId, state.userMessage, answer),
      state.extractedEntities && Object.keys(state.extractedEntities).length > 0
        ? saveEntities(state.sessionId, state.extractedEntities)
        : Promise.resolve(),
      shouldSemanticCache ? saveToCache(state.userMessage, answer) : Promise.resolve(),
    ]);
  } catch {
    // Non-critical — continue
  }

  await logObservability(state, latencyMs);

  return {
    answer,
    nodesReferenced,
    confidence,
    latencyMs,
    usedFallback,
  };
}

async function logObservability(state: O2CGraphState, latencyMs: number): Promise<void> {
  try {
    const logData: ObservabilityLog = {
      timestamp: new Date().toISOString(),
      sessionId: state.sessionId,
      cacheHit: false,
      tierUsed: state.tierToUse,
      intentType: state.intentType,
      functionCalled: state.selectedFunction?.name ?? '',
      pathTaken: state.pathTaken,
      retryCount: state.retryCount,
      latencyMs,
      recordsReturned: state.queryResults?.length ?? 0,
      confidence: state.confidence || '',
      usedFallback: state.usedFallback,
    };
    await log(logData);
  } catch {
    // Non-critical
  }
}

