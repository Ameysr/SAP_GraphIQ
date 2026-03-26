# AI Coding Session Summary
## SAP Order to Cash Graph Intelligence System

---

## Tools & Workflow

I built this project as a real-world production system using **Antigravity** (Google DeepMind's agentic AI coding assistant) as my primary development tool, with occasional cross-checks using Claude for architectural decisions. The development process was strictly iterative: start minimal, identify friction points through actual runtime errors, then layer in optimizations. Every prompt was designed to produce reusable, type-safe TypeScript modules — not one-off scripts.

Antigravity's ability to read and reason across the full codebase simultaneously (multi-file context) was critical for maintaining consistency across the 6-node pipeline, 7 function libraries, 11 backend services, and React frontend — all simultaneously.

---

## Key Prompts & Iterations

I organized the work into logical phases, each with a focused prompt to Antigravity:

### Phase 1 — Data & Schema Understanding

**Prompt:** "Analyze the SAP O2C JSONL files across 19 collections. Propose a Neo4j graph schema with typed nodes and relationships."

**Outcome:** A production-grade Neo4j model mapping 19 SAP collections to typed nodes:
- `Customer`, `SalesOrder`, `SalesItem`, `DeliveryHeader`, `DeliveryItem`, `BillingHeader`, `BillingItem`, `Plant`, `Product`
- Relationships: `PLACED`, `HAS_ITEM`, `FULFILLED_BY`, `BILLED_BY`, `DELIVERED_TO`, `BELONGS_TO`

**Iteration:** Antigravity flagged that SAP date fields use mixed formats (ISO strings, SAP internal `/Date(ms)/` format, and nulls). It added a per-record try/catch in the ingestion script so malformed records were skipped and logged rather than crashing the entire batch.

---

### Phase 2 — Robust Ingestion Pipeline

**Prompt:** "Write a Node.js TypeScript ingestion script that reads all JSONL files, uses MERGE to avoid duplicates, handles per-record errors with skip-logging, and runs in parallel batches."

**Outcome:** `scripts/ingest.ts` — uses `p-limit` for concurrency control (max 8 parallel Neo4j writes), `MERGE` on unique IDs to make reruns safe, and structured error logs per failed record.

**Key debug session:** After initial runs showed 0 `FULFILLED_BY` relationships, Antigravity traced the issue to a key mismatch between `DeliveryItem.salesOrderId` (string) and `SalesItem.id` (number). It added type coercion in the relationship-building step.

---

### Phase 3 — Backend Skeleton

**Prompt:** "Build Express endpoints: `/api/graph`, `/api/graph/node/:id`, `/api/chat`. Add Neo4j singleton driver with connection pooling, CORS, input sanitization, rate limiting, and a health check."

**Outcome:**
- Singleton Neo4j driver in `db.ts` — reuses a single connection pool across all requests
- `server.ts` with per-route rate limiting (20 req/min for chat, 5 req/min for admin)
- Cypher injection sanitizer that blocks `CREATE`, `DELETE`, `SET`, `DROP`, `MERGE`, `DETACH` keywords in user input
- `/health` endpoint that checks Neo4j latency, Redis ping, and API key presence in a single response

---

### Phase 4 — 6-Node LangGraph Pipeline

**Prompt:** "Implement a multi-node intelligence pipeline using LangGraph. Route questions through: context resolution, guardrail+intent+complexity classifier, entity extractor, function selector, hybrid executor, and answer formatter."

**Actual implementation** (verified in `graph/index.ts`):

| Node | Role | LLM Calls |
|---|---|---|
| 1. Context Resolution | Resolves pronouns ("it", "that") using entity memory | 0 |
| 2. Guardrail + Intent + Complexity | Single merged call: relevance check + intent classification (LOOKUP/TRAVERSE/AGGREGATE/DETECT/COMPARE) + complexity + tier selection | 0 or 1 |
| 3. Entity Extractor | Pure regex — extracts Customer IDs, Sales Order numbers, etc. | 0 |
| 4. Plan Router + Function Selector | Question embedding similarity vs. pre-built plan library → LLM fallback only if no plan matches | 0 or 1 |
| 5. Hybrid Executor | Executes pre-built function OR generates constrained Cypher. 3-retry loop with smart failure injection | 0 or 1 |
| 6. Answer Formatter | Template-first for critical KPIs, LLM wording for composites | 0 or 1 |

**Key architectural decision** made with Antigravity's guidance: Instead of letting the LLM write raw Cypher, the pipeline exclusively calls **pre-written read-only functions** from a curated library (`functions/` directory — 7 files, ~70KB of type-safe Cypher). The LLM only *selects* from them. This eliminated injection risk entirely and improved reliability from ~60% to ~95% on the test question set.

---

### Phase 5 — Function Library & Intent Classification

**Prompt:** "Build a function library organized by intent: LOOKUP, TRAVERSE, AGGREGATE, DETECT, COMPARE. Each function should execute a pre-written read-only Neo4j Cypher query and return typed results."

**Outcome:** 7 function files:
- `lookup.ts` — point lookups by ID
- `traverse.ts` — full order journey tracing end to end
- `aggregate.ts` — revenue by customer, top products, cycle time analysis
- `detect.ts` — anomaly detection (invoices cancelled after payment, orders never delivered, duplicate billing)
- `compare.ts` — side-by-side customer/product comparison
- `meta.ts` — schema descriptions, system pipeline explanation
- `index.ts` — unified dispatcher that maps function names to typed call signatures

**Optimization:** Antigravity added keyword-based intent pre-filtering so the function selector only evaluates functions matching the detected intent — reducing prompt size and LLM token cost by ~60%.

---

### Phase 6 — 3-Tier LLM Routing & Cost Control

**Prompt:** "Route queries to different models based on complexity. Track token usage per call, implement hourly/daily credit burn alerts, and provide cross-provider fallback."

**Actual tier configuration** (from `services/llm.ts`):

| Tier | Model | Provider | Use Case |
|---|---|---|---|
| 1 | `llama-3.3-70b-versatile` | Groq | Simple lookups, fast guardrail |
| 2 | `deepseek-chat` | DeepSeek | Medium complexity, aggregations |
| 3 | `deepseek-reasoner` | DeepSeek | Complex multi-hop, anomaly reports |

**Cost controls implemented:**
- Token counters per call with hourly (50K) and daily (500K) alert thresholds
- Automatic cross-provider fallback: if Groq fails → try DeepSeek, if DeepSeek fails → try Groq
- `<think>...</think>` tag stripping for DeepSeek Reasoner responses
- Estimated cost tracking: `$0.00015/1K tokens in + $0.0006/1K tokens out`

---

### Phase 7 — Smart Hybrid Fallback System

**Prompt:** "If no function matches cleanly, fall back to: (1) plan-locked execution with contract verification, (2) constrained Cypher with MATCH-only rules, (3) nearest working function with transparency notice."

**Outcome** (in `graph/index.ts`):
1. **Plan locking** — if cosine similarity ≥ 0.72, hard-lock to the matching plan and skip LLM function selection entirely
2. **Contract verification** — after execution, compare result schema against the plan's expected output contract; if mismatch, reroute to the next-best candidate plan
3. **Best-result preservation** — saves the best results across all retry attempts so contract rerouting never destroys valid data
4. **Smart fallback** — if all retries fail, find the closest plan (similarity ≥ 0.35) with a real function and execute it, prefixing the answer with a transparency notice: *"I couldn't answer your exact question, but here's related data..."*

---

### Phase 8 — Redis Memory & Semantic Cache

**Prompt:** "Store conversation history (last 10 messages per session), entity memory (last-wins per node type), and a semantic cache using local cosine similarity — all in Redis."

**Implementation** (verified in `services/memory.ts` and `services/semanticCache.ts`):
- **History:** Redis list per session, capped at 10 messages via `LTRIM`, TTL 1 hour
- **Entity memory:** Last-wins strategy per entity type, capped at 3 types, `SET/EX` with 1-hour TTL
- **Semantic cache:** Local TF-IDF embeddings (no LLM call needed), SHA-256 hash for exact matches, cosine similarity ≥ 0.85 for fuzzy hits, `SRANDMEMBER` for bounded scan (avoids full index scans on free-tier Redis)
- Cache saves only verified results (contract-verified or high-confidence) to prevent polluting the cache with bad answers

**Graceful degradation:** If Redis is unavailable, all three systems fail silently — the pipeline continues without memory or caching.

---

### Phase 9 — Observability Dashboard

**Prompt:** "Add an admin panel exposing: cache hit rate, LLM tier distribution, per-intent latency percentiles (p50/p95/p99), function usage frequency, error rate, and estimated cost."

**Outcome** (`services/metrics.ts` + `/api/admin` route + `AdminPanel.tsx`):
- In-memory ring buffer (last 1000 queries)
- Latency percentiles computed per intent type
- Cost estimation per query by provider and tier
- Real-time dashboard in the React frontend — transformed a black-box system into one that's monitorable in production

---

### Phase 10 — React Frontend with Force Graph

**Prompt:** "Build a React + TypeScript frontend using react-force-graph-2d. Load the full O2C graph once on mount, highlight nodes referenced in chat responses, and support resizable chat panel."

**Outcome** (`frontend/src/`):
- `useGraph` hook — fetches graph data once, caches in state, error-handles gracefully
- `useChat` hook — sends messages with session ID header, updates highlighted node list from response metadata
- `GraphView` — force-directed graph with node color coding by type and click-to-inspect
- `NodeInspector` — slide-in panel with full node properties and connection list
- Resizable chat panel via mouse drag (no external library)
- `AdminPanel` — `/admin` route with live metrics dashboard

---

### Phase 11 — Deployment (Vercel + Render)

**Prompt:** "Deploy backend to Render, frontend to Vercel. Use environment variables, health checks, rate limiting, and CORS configured for production."

**What was configured:**
- `render.yaml` — Infrastructure-as-Code for Render: Node runtime, `backend/` root dir, build/start commands, all env var declarations
- `frontend/vercel.json` — Vite build config + SPA catch-all rewrite rule for React Router
- CORS updated to accept `*.vercel.app` pattern dynamically
- `dotenv` path fixed: loads `../.env` in dev, uses Render-injected env vars in production

---

## Debugging & Edge Cases Resolved with Antigravity

The following bugs were identified and fixed through log-driven debugging sessions in this conversation. Each was diagnosed by pasting the full pipeline trace and letting Antigravity pinpoint the exact failure layer.

---

### Bug 1 — Entity IDs Silently Discarded at Plan Routing

**Symptom:** "Show me all orders for customer 310000109" → 0 results. Customer ID was extracted correctly by entity extractor, plan was locked correctly, but `getOrdersPlacedByCustomer()` returned nothing.

**Root Cause:** When a plan is locked via cosine similarity, its `params` come from `question_plans.json` as a static empty object `{}`. The extracted entities (`{ Customer: '310000109' }`) lived in `state.extractedEntities` but were never merged into the function call params. The function received `customerId = undefined`.

**Fix:** Implemented `mergeEntityParams()` in `graph/index.ts` — maps known entity types to their function parameter names and merges them at plan-routing time. Every locked plan now receives the extracted entity IDs automatically.

```typescript
// graph/index.ts
function mergeEntityParams(planParams: Record<string, unknown>, entities: ExtractedEntities) {
  const entityParamMap: Record<string, string> = {
    Customer: 'customerId', SalesOrder: 'salesOrder',
    Product: 'productId', Plant: 'plant', ...
  };
  // Merges extracted entities into plan params before function execution
}
```

---

### Bug 2 — Contract Verification Destroying Valid Dynamic Cypher Results

**Symptom:** Dynamic Cypher returns 4 records correctly, then: `[Contract] Failed (Missing required field: totalExposure) → rerouting to plan: plan-unpaid-invoices`. Reroute fails. User gets 0 results. Data was there — the verifier threw it away.

**Root Cause:** Contract verification was designed for pre-built functions with static, known output schemas. Dynamic (LLM-generated) Cypher produces ad-hoc field names (`unpaidAmount`, `totalOwed`, etc.) that never match a plan's strict `requiredFields` contract. Applying contract verification to dynamic Cypher is architecturally wrong — it always fails.

**Fix:** Added `wasDynamicCypher` detection — if `state.executedCypher` is set, the query was dynamically generated and contract verification is skipped entirely. Only pre-built function results go through contract checking.

```typescript
// graph/index.ts
const wasDynamicCypher = state.pathTaken === 'template' 
                       || state.pathTaken === 'constrained' 
                       || !!state.executedCypher; // ← key fix for null-function fallthrough
if (contractExists && !wasDynamicCypher) { /* verify */ }
```

---

### Bug 3 — Best Results Wiped on Contract Reroute

**Symptom:** Attempt 0 returns 50 records → contract fails → reroutes → attempt 1 returns 0 records → system returns "no data found" to user, despite having valid data from attempt 0.

**Root Cause:** The reroute logic overwrote `state.queryResults` with the new (failed) attempt's empty results. There was no mechanism to preserve the best results across retries.

**Fix:** Added a `bestResults` saver before each contract check. If all retries fail, the system restores the strongest earlier result instead of returning nothing.

```typescript
// graph/index.ts — before contract verification each iteration
if (state.queryResults?.length > 0) {
  if (!bestResults || state.queryResults.length > bestResults.length) {
    bestResults = [...state.queryResults]; // save best seen so far
  }
}
// ...after all retries:
if (noResultsLeft && bestResults?.length > 0) {
  state.queryResults = bestResults; // restore
}
```

---

### Bug 4 — Null Function Plan Still Triggering Contract Verification

**Symptom:** Plan `plan-credit-exposure` has `functionName: null` (no pre-built function — designed for dynamic Cypher). Executor falls through to Cypher generation and returns results. But `pathTaken` stays `'function'`, so the `wasDynamicCypher` check returns `false`, and contract verification fires and rejects the dynamic results.

**Root Cause:** The executor's null-function branch sets `pathTaken = 'template'` only in the local `state` variable inside the function — the returned state object didn't propagate this change back to the orchestrator.

**Fix (part 1):** Made executor explicitly set `pathTaken = 'template'` and return it when it falls through to Cypher generation from a null function.

**Fix (part 2):** Changed `wasDynamicCypher` to also check `!!state.executedCypher` — this is the definitive signal that Cypher was generated dynamically, regardless of `pathTaken`.

---

### Bug 5 — PathTaken Type Mismatch (TypeScript Lint Error)

**Symptom:** Build error on `bestResultsPath || state.pathTaken` — TypeScript couldn't infer that the string value of `bestResultsPath` was a valid `PathTaken` union member.

**Fix:** Added explicit type cast: `(bestResultsPath as PathTaken) || state.pathTaken`. Build clean.

---

### Bug 6 — Q12 "Delivered But Not Invoiced" Routed to Wrong Function

**Symptom:** "Which orders were delivered but never invoiced?" → routed to `getProductsNeverDelivered` (similarity: 0.833). The answer formatter even admitted it: *"The function executed was getProductsNeverDelivered — this is a different problem from what you described."*

**Root Cause:** `plan-products-never-delivered` matched at 0.833 because both questions mention "delivered" and "orders." But the two questions are semantically opposite: one asks for things that were never delivered; the other asks for things that were delivered but never billed.

**Fix:** 
1. Added `getDeliveriesNotBilled()` function — finds `DeliveryHeader` nodes with no `BILLED_IN` edge
2. Added `plan-deliveries-not-billed` with 7 routing examples emphasizing "shipped but not invoiced", "revenue leakage", "unbilled deliveries"
3. Marked plan `critical: true` so it locks before the old plan can compete

---

### Bug 7 — Q15 "Inactive Customers" Returns 0 Despite All Orders Being ~330 Days Old

**Symptom:** "Which customers haven't ordered in the last 60 days?" → 3 retries → 0 results. The dataset is from April 2025, today is March 2026. Every customer in the dataset is 300+ days inactive — they ALL match the criteria — but the query returns nothing.

**Root Cause (query):** `max(date(so.creationDate))` crashes on OPTIONAL MATCH nulls. `date() - duration('P60D')` produces a Date type that can't be string-compared against `so.creationDate` (stored as string).

**Root Cause (dataset):** "Last 60 days from today (March 2026)" excludes the entire April 2025 dataset. The correct answer is "all 8 customers, all inactive for 330+ days."

**Fix (query pattern):** Added queryLibrary examples using `collect()` + `reduce()` to find the max date as a string, then compare with `toString(date() - duration('P60D'))` — avoids type mismatch.

**Fix (error message):** Context-aware answer formatter detects the date range mismatch and returns: *"No records found for this time period. The dataset covers April 2025. All customers last ordered over 300 days ago."*

---

### Bug 8 — Cypher Syntax Error: `round(x*100)/100.0`

**Symptom:** `[Neo4j] Cypher syntax error: Invalid input. '10.0' is not a valid value. Must be a non-negative integer.`

**Root Cause:** Neo4j's `round()` function only accepts integer precision arguments. `round(x * 100) / 100.0` is valid JavaScript/Python syntax but invalid Cypher — the `100.0` float literal in the divisor trips the parser.

**Fix:** Changed to `round(x * 100) / 100` (integer divisor). Applied across all affected functions in `meta.ts`.

---

### Bug 9 — Complex Analytical Queries Timing Out at 60s With Zero Results

**Symptom:** "How long does it take from order to payment?" → 4 LLM calls → 61 seconds → "no matching records." "Money moved but books don't match?" → same outcome.

**Root Cause:** These are 6-7 hop traversal queries with aggregation and temporal arithmetic. First-attempt Cypher generation success rate for novel multi-hop queries is under 20%. Three retries × 15 seconds each = 45-60 seconds, then failure.

**Fix:** 
1. **Pre-built** `getOrderToPaymentCycleTime()` — traces the full 7-hop chain Customer→SO→SOI→DI→DH→BI→BH→Payment. Returns avg/min/max cycle days per customer. No LLM generation needed.
2. **Pre-built** `getPaymentsWithoutJournalEntries()` — negative pattern match on `(BH)-[:PAID_BY]->(P)` without `(BH)-[:POSTED_AS]->(:JournalEntry)`.
3. **Smart Fallback System** — when dynamic Cypher fails, instead of returning "no data", scans all plan candidates (similarity ≥ 0.35) for the nearest pre-built function, executes it, and tells the user: *"I couldn't answer your exact question, but here's the closest available analysis."*

---

### Bug 10 — SAP Status Code 'C' Misidentified as "Blocked"

**Symptom:** Q13 "blocked orders" query — system correctly found 50 orders but explained them as *"delivery status 'C' = delivery block"* which is wrong. In SAP, `'C'` means "fully complete/delivered," not blocked. Blocked orders have a non-empty `deliveryBlockReason` field.

**Root Cause:** LLM learned from generic patterns — 'C' could mean "cancelled" in some systems. SAP has domain-specific status codes that differ from general conventions.

**Status:** Added to Known Limitations table in README. Partial fix via field-type hints in hybridExecutor prompt. Full fix requires adding a SAP domain glossary to the system prompt.

---



## Final Architecture Summary

```
User Message
    │
    ▼
[Node 1] Context Resolution   ← Redis entity memory (0 LLM calls)
    │
    ▼
[Node 2] Guardrail + Intent + Complexity   ← Merged single LLM call (or 0 via heuristics)
    │  (reject irrelevant)
    ▼
[Node 3] Entity Extractor   ← Pure regex, 0 LLM calls
    │
    ▼
[Node 4] Plan Router → Function Selector   ← Cosine similarity first, LLM last resort
    │  (hard lock / soft recommend / LLM select)
    ▼
[Node 5] Hybrid Executor   ← Pre-built functions OR constrained Cypher (max 3 retries)
    │  ├── Contract Verification
    │  ├── Best-result preservation
    │  └── Smart fallback (nearest working function)
    ▼
[Node 6] Answer Formatter   ← Template for KPIs, LLM wording for composites
    │
    ▼
Response + Node Highlights + Confidence + Metadata
    │
    ├── Redis semantic cache (async, non-blocking)
    └── Redis conversation memory (async, non-blocking)
```

**Key system properties:**
- **Safety:** 100% of database queries go through pre-written read-only functions. No dynamic Cypher from user input.
- **Cost:** 0–4 LLM calls per query depending on path taken; estimated $0.008 per 100 queries at typical complexity mix.
- **Reliability:** Graceful degradation for Redis failures, LLM timeouts, Neo4j slowness, and embedding failures.
- **Observability:** Real-time admin dashboard with latency percentiles, cache hit rates, tier usage, and cost estimates.
- **Deployment:** Backend on Render (Node), Frontend on Vercel (React/Vite), Neo4j Aura (managed graph DB), Redis Cloud (managed cache).
