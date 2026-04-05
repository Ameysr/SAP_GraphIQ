import type { O2CGraphState } from '../state.js';
import type { IntentType, ComplexityLevel, TierNumber } from '../../types/index.js';
import { callLLM } from '../../services/llm.js';

// ── 5-LAYER GUARDRAIL SYSTEM ──────────────────────────────────────────────────

// Layer 1: Keyword blocklist (instant, 0 cost)
// Use word-boundary regex to avoid false positives like 'dataset' matching 'set'
const BLOCKED_KEYWORD_PATTERNS = [
  /\bdelete\b/i, /\bdrop\b/i, /\btruncate\b/i, /\bdetach\b/i, /\bdestroy\b/i,
  /\bmerge\b/i, /\bload\s+csv\b/i,
  /\bporn\b/i, /\bhack\b/i, /\bexploit\b/i, /\binjection\b/i, /\bpassword\b/i, /\bcredential\b/i,
];

// SAP business terms that should NEVER be blocked even if they contain suspicious substrings
const WHITELIST_PATTERNS = [
  /expensive/i, /billing\s*item/i, /highest.*amount/i, /largest.*invoice/i,
  /top.*revenue/i, /most.*costly/i, /dataset/i, /\bset\s+of\b/i,
];

// Layer 4: Cypher write-operation detector
const CYPHER_WRITE_OPS = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|CALL|LOAD\s+CSV|FOREACH)\b/i;

export function validateCypher(cypher: string): { valid: boolean; reason?: string } {
  // Block window functions — the LLM sometimes generates `... OVER () ...`
  // which frequently breaks in Neo4j config / dialect and wastes retries.
  if (/\bOVER\b/i.test(cypher)) {
    return { valid: false, reason: 'Window function usage (OVER) detected — blocked' };
  }
  if (CYPHER_WRITE_OPS.test(cypher)) {
    return { valid: false, reason: `Write operation detected: ${cypher.match(CYPHER_WRITE_OPS)?.[0]}` };
  }
  // Check for excessive MATCH without WHERE (potential cartesian product / DoS)
  const matchCount = (cypher.match(/\bMATCH\b/gi) || []).length;
  const whereCount = (cypher.match(/\bWHERE\b/gi) || []).length;
  if (matchCount > 3 && whereCount === 0) {
    return { valid: false, reason: 'Multiple MATCH without WHERE — potential cartesian explosion' };
  }
  return { valid: true };
}

// Layer 5: Result size limiter
export function enforceSizeLimit(cypher: string): string {
  if (!/\bLIMIT\b/i.test(cypher)) {
    return cypher.trimEnd().replace(/;?\s*$/, ' LIMIT 50');
  }
  // If LIMIT exists, cap at 50 to keep executor + answerFormatter consistent.
  return cypher.replace(/LIMIT\s+(\d+)/i, (_match, n) => {
    const num = parseInt(n, 10);
    return `LIMIT ${Math.min(num, 50)}`;
  });
}

// ── KEYWORD-BASED INTENT RULES (no LLM cost) ────────────────────────────────
// Word-boundary regex patterns for intent classification
// Using \b prevents "accounting" matching "count", "customerId" matching "most", etc.
// ORDER MATTERS: DETECT has priority over TRAVERSE, TRAVERSE over AGGREGATE, etc.
// But LOOKUP is checked first in classifyIntentByKeyword when an entity ID is present.
const INTENT_RULES: Array<{ patterns: RegExp[]; intent: IntentType }> = [
  {
    patterns: [/\bbroken\b/i, /\bmissing\b/i, /\bnot billed\b/i, /\bunpaid\b/i, /\bincomplete\b/i, /\bno delivery\b/i, /\bnot paid\b/i, /\bundelivered\b/i, /\bunbilled\b/i, /\banomal/i, /\bfulfillment\b/i, /\bcancelled after\b/i, /\bcancelled before\b/i],
    intent: 'DETECT',
  },
  {
    patterns: [/\btrace\b/i, /\bflow\b/i, /\bpath\b/i, /\bend to end\b/i, /\bfull journey\b/i, /\bfrom order to\b/i, /\bfollow\b/i, /\bchain\b/i, /\blifecycle\b/i],
    intent: 'TRAVERSE',
  },
  {
    patterns: [/\btop\s+\d/i, /\bcount\b/i, /\bhow many\b/i, /\bhighest\b/i, /\blowest\b/i, /\brank\b/i, /\bbest\b/i, /\bworst\b/i, /\btotal\b/i, /\bsum\b/i, /\baverage\b/i, /\bdistribution\b/i, /\bdistributed\b/i, /\bclearing time\b/i, /\bpayment term/i, /\bexpensive\b/i, /\bpercentage\b/i, /\b%\b/],
    intent: 'AGGREGATE',
  },
  {
    // "most" is checked separately — only counts as AGGREGATE when no entity ID present
    patterns: [/\bmost\b/i],
    intent: 'AGGREGATE',
  },
  {
    patterns: [/\bcompare\b/i, /\bvs\b/i, /\bversus\b/i, /\bdifference between\b/i, /\bwhich is better\b/i],
    intent: 'COMPARE',
  },
  {
    patterns: [/\bshow\b/i, /\bget\b/i, /\bwhat is\b/i, /\bfind me\b/i, /\btell me about\b/i, /\bdetails of\b/i, /\blook up\b/i, /\bwho is\b/i, /\bwhat are\b/i, /\bdescribe\b/i, /\bfull details\b/i],
    intent: 'LOOKUP',
  },
];

// ── SCHEMA / CONCEPTUAL / META QUESTION DETECTION ────────────────────────────
// These questions are about the GRAPH STRUCTURE, not the DATA in the graph.
// They must NOT go through plan routing or data queries — they need meta functions.

function isSchemaDesignQuestion(msg: string): boolean {
  const lower = msg.toLowerCase();

  // Strip quoted text to avoid matching keywords inside user-provided examples
  const stripped = lower.replace(/['"][^'"]*['"]/g, '');

  // Pattern 1: Explicit schema/modeling vocabulary
  const schemaKeywords =
    stripped.includes('schema') ||
    stripped.includes('property graph') ||
    stripped.includes('node label') ||
    stripped.includes('node type') ||
    stripped.includes('graph model') ||
    stripped.includes('graph design') ||
    stripped.includes('data model');

  // Pattern 2: Relationship/edge topology questions
  //   "What relationship connects X to Y?"
  //   "What edge connects SalesOrder to SalesOrderItem?"
  //   "What direction should the edge go?"
  const topologyQuestion =
    (stripped.includes('relationship') || stripped.includes('edge')) &&
    (stripped.includes('connect') || stripped.includes('direction') ||
     stripped.includes('cardinality') || stripped.includes('between') ||
     stripped.includes('link'));

  // Pattern 3: "How would you represent X in a graph?" / "How to model X?"
  const modelingQuestion =
    (stripped.includes('represent') || stripped.includes('model')) &&
    (stripped.includes('graph') || stripped.includes('node') || stripped.includes('edge'));

  // Pattern 4: Node vs edge property conceptual questions
  const conceptualQuestion =
    (stripped.includes('difference between') || stripped.includes('what is a')) &&
    (stripped.includes('node') || stripped.includes('edge') || stripped.includes('property') ||
     stripped.includes('relationship'));

  // Domain check: must mention SAP O2C entities
  const isDomain = /(order to cash|\bo2c\b|sales\s*order|delivery|billing|invoice|payment|journal|customer|product|plant|sap)/i.test(msg);

  // Schema questions can be domain-specific OR purely conceptual about graphs
  if (schemaKeywords && isDomain) return true;
  if (topologyQuestion) return true;  // "What edge connects X to Y" is always a schema question
  if (modelingQuestion) return true;  // "How to represent X in graph" is always a schema question
  if (conceptualQuestion) return true; // "Difference between node/edge" is always a schema question

  return false;
}

// ── META-SYSTEM QUESTION DETECTION ────────────────────────────────────────────
// Questions about how the NL system itself works (architecture, translation, etc.)
// These should be answered from system knowledge, not by querying the DB.
function isMetaSystemQuestion(msg: string): boolean {
  const lower = msg.toLowerCase();
  // Strip quoted text
  const stripped = lower.replace(/['"][^'"]*['"]/g, '');

  const asksAboutSystem =
    stripped.includes('your system') || stripped.includes('your natural language') ||
    stripped.includes('how does the system') || stripped.includes('how do you') ||
    stripped.includes('how does your') || stripped.includes('nl system') ||
    stripped.includes('translate') || stripped.includes('pipeline');

  const asksAboutTranslation =
    stripped.includes('graph query') || stripped.includes('cypher') ||
    stripped.includes('translate') || stripped.includes('interpret');

  return asksAboutSystem && asksAboutTranslation;
}

// ── INLINE COMPLEXITY ASSIGNMENT ──────────────────────────────────────────────
// Replaces the old standalone complexityClassifier.ts node.
// When keywords resolve intent, we assign complexity deterministically (no LLM).
function assignComplexity(intent: IntentType, msg: string): { complexity: ComplexityLevel; tierToUse: TierNumber } {
  const lower = msg.toLowerCase();
  switch (intent) {
    case 'LOOKUP':
      return { complexity: 'SIMPLE', tierToUse: 1 };

    case 'TRAVERSE': {
      const isComplex = ['full', 'complete', 'entire', 'end to end', 'all steps', 'chain', 'lifecycle']
        .some((kw) => lower.includes(kw));
      return isComplex
        ? { complexity: 'COMPLEX', tierToUse: 3 }
        : { complexity: 'MEDIUM', tierToUse: 2 };
    }

    case 'AGGREGATE':
      return { complexity: 'MEDIUM', tierToUse: 2 };

    case 'DETECT':
    case 'COMPARE':
    case 'UNKNOWN':
    default:
      return { complexity: 'COMPLEX', tierToUse: 3 };
  }
}

/**
 * MERGED guardrail + intent + complexity classifier.
 *
 * This single node replaces what used to be 3 separate nodes:
 * - guardrail (relevance check)
 * - intentClassifier (intent detection)
 * - complexityClassifier (tier assignment)
 *
 * Priority:
 * 1. Layer 1: Keyword blocklist (instant, free)
 * 2. Layer 2: Short follow-up auto-allow (free)
 * 3. Keyword-based intent + complexity detection (free) — if matched, skip LLM
 * 4. Layer 3: SINGLE LLM call that returns relevance + intent + complexity + tier
 */
export async function guardrail(
  state: O2CGraphState
): Promise<Partial<O2CGraphState>> {
  const msg = state.resolvedMessage;

  // ── Schema/Conceptual question detection (before everything else) ──
  // These MUST NOT go through plan routing — they need meta functions or direct answers.
  if (isSchemaDesignQuestion(msg)) {
    console.log(`  [Guardrail] Schema/conceptual question detected — routing to SCHEMA path`);
    return {
      isRelevant: true,
      intentType: 'TRAVERSE',
      complexity: 'COMPLEX',
      tierToUse: 2,
      // Mark as schema question so index.ts can skip plan routing
      pathTaken: 'schema',
    };
  }

  // ── Meta-system question detection ──
  // "How does your NL system translate to graph queries?" — answer from system knowledge
  if (isMetaSystemQuestion(msg)) {
    console.log(`  [Guardrail] Meta-system question detected — direct answer`);
    return {
      isRelevant: true,
      intentType: 'TRAVERSE',
      complexity: 'MEDIUM',
      tierToUse: 2,
      pathTaken: 'schema',
    };
  }

  // ── Layer 1: Keyword block (instant) ──
  const isWhitelisted = WHITELIST_PATTERNS.some(p => p.test(msg));
  if (!isWhitelisted) {
    for (const pattern of BLOCKED_KEYWORD_PATTERNS) {
      if (pattern.test(msg)) {
        console.log(`  [Guardrail] Layer 1 BLOCKED: pattern ${pattern}`);
        return {
          isRelevant: false,
          answer: 'This query contains blocked content and cannot be processed.',
        };
      }
    }
  }

  // ── Layer 1b: Obviously off-topic detection (instant, no LLM) ──
  // Catches general-knowledge / creative / personal questions that should never
  // reach the pipeline — saves an LLM call.
  const OFF_TOPIC_PATTERNS = [
    /\b(?:weather|forecast|temperature)\b/i,
    /\b(?:joke|funny|humor|laugh)\b/i,
    /\b(?:poem|poetry|song|lyrics|story|write me)\b/i,
    /\b(?:recipe|cook|food|restaurant)\b/i,
    /\b(?:code|program|javascript|python|html|css|react)\b/i,
    /\b(?:translate to|translate from|speak|language)\b/i,
    /\b(?:news|politics|election|sports|game|movie|music)\b/i,
    /\b(?:who is the president|capital of|population of)\b/i,
    /\b(?:meaning of life|philosophy|opinion|feel|believe)\b/i,
  ];
  // But don't block if SAP/O2C terms are also present
  const hasSAPContext = /\b(?:order|customer|delivery|billing|invoice|payment|product|plant|sales|sap|o2c)\b/i.test(msg);
  if (!hasSAPContext) {
    for (const pattern of OFF_TOPIC_PATTERNS) {
      if (pattern.test(msg)) {
        console.log(`  [Guardrail] Off-topic detected: ${pattern}`);
        return {
          isRelevant: false,
          answer: `I'm designed specifically for SAP Order-to-Cash analysis. I can help with questions like:\n\n• "Show top 5 customers by revenue"\n• "Find orders that were never delivered"\n• "What is the O2C cycle time per customer?"\n• "Trace the journey of sales order 740544"\n\nPlease ask something about orders, customers, deliveries, billing, or payments.`,
        };
      }
    }
  }

  // ── Layer 2: Short follow-up auto-allow ──
  if (state.userMessage.length < 60 && state.history.length > 0) {
    console.log(`  [Guardrail] Layer 2: Short follow-up with history — auto-allowed`);
    const intent = classifyIntentByKeyword(msg);
    if (intent) {
      const { complexity, tierToUse } = assignComplexity(intent, msg);
      console.log(`  [Guard+Intent+Complexity] Keyword: ${intent} / ${complexity} / Tier ${tierToUse} — 0 LLM calls`);
      const result: Partial<O2CGraphState> = { isRelevant: true, intentType: intent, complexity, tierToUse };
      if (intent === 'COMPARE') result.pathTaken = 'template';
      return result;
    }
    return { isRelevant: true };
  }

  // ── Layer 3a: Keyword-based intent + complexity detection ──
  // IMPORTANT: Strip quoted text before keyword matching to prevent
  // "A user types: 'Show me orders...'" from triggering LOOKUP on "Show"
  const strippedMsg = msg.replace(/['"][^'"]*['"]/g, '').trim();
  const keywordIntent = classifyIntentByKeyword(strippedMsg.length > 10 ? strippedMsg : msg);
  if (keywordIntent) {
    const { complexity, tierToUse } = assignComplexity(keywordIntent, msg);
    console.log(`  [Guard+Intent+Complexity] Keyword-matched: ${keywordIntent} / ${complexity} / Tier ${tierToUse} — 0 LLM calls`);
    const result: Partial<O2CGraphState> = { isRelevant: true, intentType: keywordIntent, complexity, tierToUse };
    if (keywordIntent === 'COMPARE') result.pathTaken = 'template';
    if (keywordIntent === 'UNKNOWN') result.pathTaken = 'constrained';
    return result;
  }

  // ── Layer 3b: SINGLE LLM call — relevance + intent + complexity in ONE call ──
  const systemPrompt = `You are a guardrail + classifier for a SAP Order-to-Cash dataset query system.
Reply with ONLY valid JSON: { "relevant": true, "intent": "AGGREGATE", "complexity": "MEDIUM", "tier": 2, "confidence": 0.95 }
OR: { "relevant": false, "intent": "UNKNOWN", "complexity": "SIMPLE", "tier": 1, "confidence": 0.90 }

INTENT must be one of: LOOKUP, TRAVERSE, AGGREGATE, DETECT, COMPARE, UNKNOWN
- LOOKUP: Get details about a specific entity by ID
- TRAVERSE: Trace a flow/journey/path through the O2C chain
- AGGREGATE: Counts, totals, rankings, distributions, top/bottom queries
- DETECT: Find anomalies, broken flows, missing links, fulfillment issues
- COMPARE: Compare two entities side-by-side

COMPLEXITY must be one of: SIMPLE, MEDIUM, COMPLEX
TIER must be: 1 (simple lookups), 2 (aggregation/ranking), 3 (multi-hop/anomaly/novel)
- SIMPLE + tier 1: Single entity lookup, basic count, single-hop query
- MEDIUM + tier 2: Aggregation, ranking, multi-field filtering, standard analytics
- COMPLEX + tier 3: Multi-hop traversal, anomaly detection, cross-domain analysis, comparison, novel questions

Return relevant: true for ANY question about:
- Sales orders, deliveries, billing documents, payments, journal entries
- Customers, products, plants, materials
- O2C business process analysis, broken flows, incomplete chains
- Financial analysis: "most expensive", "highest billing", "largest invoice", "payment terms", "clearing time", "fulfillment rate", "journal distribution"
- Follow-up questions like "tell me more", "show names", "give details"
Return relevant: false for: general knowledge, coding help, creative writing, personal questions, weather, news.
Note: If confidence is below 0.5, the system will block the query. Set confidence >= 0.5 for borderline SAP-related questions.`;

  const userPrompt = `User question: "${msg}"`;

  try {
    const response = await callLLM({
      systemPrompt,
      userPrompt,
      tier: 1,
      maxTokens: 80,
      callerTag: 'guard+intent+complexity',
    });

    try {
      const parsed = JSON.parse(response.text) as {
        relevant: boolean;
        intent?: string;
        complexity?: string;
        tier?: number;
        confidence?: number;
      };
      const confidence = parsed.confidence ?? 0.5;

      if (parsed.relevant && confidence < 0.5) {
        console.log(`  [Guardrail] Low confidence (${confidence}) — blocked`);
        return {
          isRelevant: false,
          answer: `I'm not confident I can answer this about the SAP O2C dataset. Here are some things I can help with:\n\n• Customer & order analytics (revenue, rankings, distributions)\n• Delivery & fulfillment tracking\n• Billing & payment analysis (aging, DSO, clearing times)\n• Anomaly detection (broken flows, missing deliveries)\n• End-to-end O2C journey tracing\n\nTry rephrasing your question with specific SAP terms.`,
          usedFallback: response.usedFallback,
        };
      }

      if (parsed.relevant === false) {
        console.log(`  [Guardrail] Irrelevant (confidence: ${confidence})`);
        return {
          isRelevant: false,
          answer: `I'm designed specifically for SAP Order-to-Cash analysis. I can help with questions like:\n\n• "Show top 5 customers by revenue"\n• "Find orders that were never delivered"\n• "What is the AR aging breakdown?"\n• "Compare customer 320000082 vs 320000083"\n\nPlease ask something about orders, customers, deliveries, billing, or payments.`,
          usedFallback: response.usedFallback,
        };
      }

      // Extract intent, complexity, tier from the SAME response — no extra LLM calls!
      const validIntents: IntentType[] = ['LOOKUP', 'TRAVERSE', 'AGGREGATE', 'DETECT', 'COMPARE', 'UNKNOWN'];
      const intent = (parsed.intent?.toUpperCase() ?? 'UNKNOWN') as IntentType;
      const finalIntent = validIntents.includes(intent) ? intent : 'UNKNOWN';

      const validComplexities: ComplexityLevel[] = ['SIMPLE', 'MEDIUM', 'COMPLEX'];
      const rawComplexity = (parsed.complexity?.toUpperCase() ?? 'MEDIUM') as ComplexityLevel;
      const complexity = validComplexities.includes(rawComplexity) ? rawComplexity : 'MEDIUM';

      const rawTier = parsed.tier ?? 2;
      const tierToUse = ([1, 2, 3].includes(rawTier) ? rawTier : 2) as TierNumber;

      console.log(`  [Guard+Intent+Complexity] LLM: ${finalIntent} / ${complexity} / Tier ${tierToUse} (confidence: ${confidence}) — 1 merged call`);
      const result: Partial<O2CGraphState> = {
        isRelevant: true,
        intentType: finalIntent,
        complexity,
        tierToUse,
        usedFallback: response.usedFallback,
      };
      if (finalIntent === 'COMPARE') result.pathTaken = 'template';
      if (finalIntent === 'UNKNOWN') result.pathTaken = 'constrained';
      return result;
    } catch {
      // JSON parse failed — allow through with defaults
      return { isRelevant: true, complexity: 'MEDIUM', tierToUse: 2 };
    }
  } catch {
    // LLM call failed — allow through with defaults
    return { isRelevant: true, complexity: 'MEDIUM', tierToUse: 2 };
  }
}

function classifyIntentByKeyword(msg: string): IntentType | null {
  const lower = msg.toLowerCase();

  // If the question mentions a specific entity ID and asks for details, it's LOOKUP — check first
  // This prevents "show me most details about order 740506" from matching AGGREGATE due to /most/
  const hasEntityId = /\b\d{6,10}\b/.test(msg);
  if (hasEntityId && (lower.includes('details') || lower.includes('what is') || lower.includes('show me'))) {
    return 'LOOKUP';
  }

  for (const rule of INTENT_RULES) {
    // Skip the standalone "most" AGGREGATE rule when an entity ID is present
    // "Show me most details about order X" should be LOOKUP, not AGGREGATE
    if (rule.intent === 'AGGREGATE' && hasEntityId && rule.patterns.length === 1 && rule.patterns[0].source === '\\bmost\\b') {
      continue;
    }
    if (rule.patterns.some(p => p.test(lower))) {
      return rule.intent;
    }
  }
  return null;
}
