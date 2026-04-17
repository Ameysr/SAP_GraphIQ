# SAP Order to Cash Graph Intelligence System

An AI powered system that converts natural language questions into accurate business insights over SAP O2C data using a graph database and multi step LLM pipeline.

Built to handle real production challenges like hallucination, query safety, and accuracy.

> **Live Demo:** [https://dodge-ai-task-lilac.vercel.app/](https://dodge-ai-task-lilac.vercel.app/)

---

## What It Does

- Converts natural language → structured graph queries (Cypher) over SAP Order-to-Cash data
- 85 pre built analytical functions with deterministic execution no hallucinated data
- Handles complex multi part questions via automatic query decomposition
- Uses a hybrid deterministic + LLM approach: the LLM selects which function to call, not what data to return
- Multi step retry and fallback strategies when queries fail never returns "no data found" without trying alternatives

---

## Note

This project was originally submitted as an assignment (deadline: March 26).
After submission, I continued improving it with features like better query handling, retries, and accuracy improvements.

---

## Improvements After Submission

- Improved query handling and response accuracy (schema discovery, deterministic answer templates, query decomposition)
- Added retry and fallback strategies for failed queries (escalating retries, smart fallback to nearest working function)
- Enhanced routing precision with domain tuned embeddings, cross intent visibility, and schema aware validation
- Expanded analytical coverage with 18 new functions (DSO, AR aging, credit exposure, revenue leakage, and more)

---

## Key Features

### 1. Deterministic Query Routing
85 typed Cypher functions across 5 intents (LOOKUP, TRAVERSE, AGGREGATE, DETECT, COMPARE). The LLM only selects which function to call no raw Cypher generation, no hallucinated data, no injection attacks. A semantic similarity router powered by domain tuned TF IDF embeddings hard locks the query to a function before the LLM even sees it.

### 2. Schema Discovery Agent
On startup, a Schema Discovery Agent auto introspects Neo4j to discover all node labels, relationship types, property names, data types, and sample values. This replaces hardcoded schema maps the LLM can generate Cypher for any property in the database without manual code updates when the data model changes.

### 3. Deterministic Answer Templates
For 20+ known functions, answers are produced with **zero LLM involvement** eliminating number hallucination entirely. Pre built markdown templates format results (AR aging buckets, DSO days, credit exposure) with correct currency symbols, percentages, and counts. LLM formatting is only used for novel queries.

### 4. Query Decomposition
Complex multi part questions ("Show revenue AND delivery rates AND aging buckets") are automatically split into 2–4 independent sub queries. Each gets its own GraphRAG context, Cypher generation, and execution. Results are merged before formatting.

### 5. Escalating Retry Strategy
When Cypher generation fails, each retry uses a **fundamentally different approach** not the same context repeated:

| Retry | Strategy | Change |
|-------|----------|--------|
| 0 | Standard generation | 5 GraphRAG examples |
| 1 | Forced chain-of-thought + error analysis | 7 examples, must write fundamentally different query |
| 2 | Tier 3 escalation (deepseek-reasoner) | Aggressive simplification, 1–2 MATCH clauses only |
| 3 | Query decomposition | Breaks into 2–4 independent sub-queries |

### 6. Smart Fallback System
When all retries fail, the system doesn't return "no data found." It scans plan candidates for the nearest working pre-built function, executes it, and prefixes the answer with: *"I couldn't answer your exact question directly, but here's the closest available analysis."*

### 7. GraphRAG with Few Shot Retrieval
For novel questions outside the function library, the system retrieves top K similar Cypher examples from a 78 query library, builds a minimal schema subset from the live database, and sends structured context to the LLM not a raw prompt.

### 8. Schema Aware Cypher Validation
Before executing LLM-generated Cypher, the system validates it against the live schema: checks node labels, relationship types, and detects missing `toFloat()` on amount fields. Invalid queries are caught before hitting Neo4j, saving round-trips.

### 9. Multi Layer Memory
Redis backed conversation history + entity memory resolves pronouns across turns: *"Show me the order"* resolves to the exact ID discussed moments ago. Semantic cache (cosine similarity > 0.85) skips the full pipeline for repeated questions.

### 10. Multi Layer Security
Input sanitization strips Cypher injection attempts (`CREATE`, `DELETE`, `DROP`, `MERGE`). Rate limiting at 20/min per IP. Guardrail rejects off-topic queries before database access. Entity extraction uses regex to prevent prompt injection.

---

## Evaluation Results

```
  Accuracy        92%    useful answer rate (correct + partial)
  Exact Match     40%    numeric/entity-level precision
  Avg Latency     1.8s   deterministic path (pre-built function)
  Avg Latency    12.4s   dynamic path (LLM-generated Cypher)
  LLM Cost       $0.00   all providers on free tier
```

| Category | Queries | Accuracy | Method |
|---|---|---|---|
| Deterministic KPIs (billing totals, entity counts) | 8 | 100% | Pre-built functions with contract verification |
| Multi-hop traversals (order-to-cash chains) | 5 | 80% | Deterministic trace functions |
| Anomaly detection (broken flows, cancellations) | 5 | 100% | Pre-built detect functions + smart fallback |
| Schema and meta-system questions | 4 | 100% | Dedicated schema/meta routing bypass |
| Novel analytical queries (dynamic Cypher) | 3 | 100% | Live schema + GraphRAG few-shot generation |

---

## Architecture

```
                              User
                               |
                         [React + Vite]
                    GraphView | ChatPanel | Admin
                               |
                          HTTP / REST
                               |
                    [Express + TypeScript]
                               |
               +---------------+------------------+
               |                                  |
    [Schema Discovery Agent]              [Rate Limiter]
    (auto-introspects Neo4j on startup)    [Input Sanitizer]
               |
    [LangGraph Pipeline - 6 Nodes]
    1. Context Resolution (regex, 0 LLM)
    2. Guardrail + Intent + Complexity (keyword-first, 0 or 1 LLM)
    3. Entity Extraction (regex, 0 LLM)
    4. Plan Router + Function Selector (plan + cross-intent LLM fallback)
    5. Hybrid Executor (function OR dynamic Cypher, escalating retries + decomposition)
    6. Answer Formatter (deterministic templates OR Tier 2 LLM fallback)
               |
    +----------+-----------+----------+
    |          |           |          |
[Neo4j Aura] [Redis]  [Groq LLM] [DeepSeek]
 Graph DB    Cache     Tier 1      Tier 2/3
 19 collections       LLaMA 3     Chat/Reasoner
 19 node types
 18 relationship types
```

---

## Pipeline Deep Dive

Each query passes through 6 sequential nodes. Guardrail, intent, and complexity classification are merged into a single LLM call, eliminating 2 redundant nodes from the original 8-node design and reducing max LLM calls from 4 to 3.

| Node | What It Does | Why It Exists |
|------|-------------|---------------|
| Context Resolution | Resolves pronouns using conversation history and entity memory | "Show me the order" becomes "Show me order 740556" based on what was discussed |
| Guardrail + Intent + Complexity | Single merged node: keyword rules first (0 LLM), then one LLM call returns relevance, intent, complexity, and tier. Includes 6 few-shot classification examples. Detects schema/conceptual questions and routes them to dedicated functions before plan matching. | One call replaces three old nodes. 80% of queries resolved by keywords at 0ms. Schema questions bypass plan routing entirely. |
| Entity Extraction | Regex extracts IDs, names, dates from the question. Entities are automatically injected into function params via entity-to-param mapping. | Avoids LLM call for structured extraction. Regex is faster, cheaper, deterministic. Entity injection ensures functions like getOrdersPlacedByCustomer(customerId) receive the extracted ID. |
| Plan Router + Function Selector | Plan similarity (74 plans, hard lock for critical + soft recommendation at 0.72 threshold), then entity-specific shortcuts, then LLM fallback with **cross-intent visibility** (LLM sees primary + secondary functions from all intents). | Three-tier routing. Cross-intent visibility allows the LLM to self-correct if the guardrail misclassifies intent. |
| Hybrid Executor | Runs hardcoded function OR generates Cypher dynamically with **live schema** from Schema Agent + GraphRAG context. Escalating retries: Tier 2 → Tier 2+CoT → Tier 3 → Query decomposition. Schema-aware validation catches wrong labels/relationships before execution. | If function exists: guaranteed correct. If not: LLM generates Cypher with few-shot examples, live schema with sample values, SAP field mapping hints, and explicit type conversion rules. |
| Answer Formatter | Deterministic templates for 20+ known functions (zero LLM, zero hallucination). LLM formatting only for novel queries with result sanitization and post-LLM validation. | Template path: exact numbers, correct currency/count formatting. LLM path: contract verification, field-type guards, result deduplication. |

### Escalating Retry Loop

If the executor fails (bad Cypher, empty results), it does not just error out or repeat the same approach:

1. **Retry 1:** Forces mandatory chain-of-thought reasoning + explicit root cause diagnosis. Retrieves 7 GraphRAG examples (up from 5). Demands a fundamentally different query approach.
2. **Retry 2:** Escalates to Tier 3 (deepseek-reasoner) — the most powerful model. Forces aggressive simplification: 1-2 MATCH clauses, OPTIONAL MATCH everywhere.
3. **Retry 3:** Abandons single-query approach entirely. Uses **query decomposition** to break the question into 2-4 independent sub-queries, executes each separately, and merges results.
4. Best results from any attempt are saved — if later attempts fail, earlier successful results are restored.
5. If all retries fail, the smart fallback system finds the nearest working pre-built function and executes it with transparency.

---

## Question Plan System

74 question plans define the system's analytical capabilities. Each plan has:

- Semantic routing examples (3–7 per plan) matched using domain-tuned TF-IDF embeddings
- A target function name for deterministic execution (all 74 plans have real functions — zero null-function plans)
- A data contract for output verification
- A criticality flag that locks the plan when matched (no LLM override)
- Entity-to-param auto injection (extracted IDs are automatically merged into function params)

Plans cover billing analytics, revenue ranking, payment analysis, anomaly detection, customer profiling, delivery tracking, AR aging, DSO, credit exposure, order-to-cash cycle time, revenue leakage detection, reconciliation gaps, archiving vs blocked analysis, incoterms analysis with locations, and cross-domain summaries.

For truly novel questions (no plan match, no keyword match), the system falls through to GraphRAG: vector retrieves similar query examples, builds a live schema from the Schema Discovery Agent, and lets the LLM generate Cypher dynamically. If even this fails, the smart fallback executes the nearest available pre-built function with user transparency.

---

## LLM Tiering Strategy

| Tier | Primary | Fallback | When Used |
|------|---------|----------|-----------|
| 1 | Groq LLaMA 3.3 70B | DeepSeek Chat | Guardrail, intent classification |
| 2 | DeepSeek Chat | Groq LLaMA 3.3 70B | Function selection, Cypher generation, answer formatting |
| 3 | DeepSeek Reasoner | Groq LLaMA 3.3 70B | Complex multi-hop queries (DETECT, COMPARE) |
| Embed | Domain-tuned TF-IDF | N/A (deterministic) | Plan routing, GraphRAG retrieval, semantic cache |

DeepSeek Reasoner produces a chain-of-thought block before answering, improving accuracy on complex queries by reasoning through relationship directions and join keys before generating Cypher. The think block is stripped before JSON parsing.

Circuit breakers track per-provider failure rates. If a provider fails 3 times within 60 seconds, it is marked DOWN for 5 minutes and the fallback is used directly.

---

## Function Library

85 hardcoded Cypher functions organized by intent:

| Intent | Count | Examples |
|--------|-------|----------|
| LOOKUP | 5 | getCustomer, getOrder, getProduct, getBillingDoc, getDelivery |
| TRAVERSE | 8 | traceDocument, traceOrderJourney, getBusinessPartnerToBillingDocumentPath, getO2CGraphSchemaDesign |
| AGGREGATE | 50 | getRevenueConcentration, getPlantRevenueRanking, getActiveBillingTotals, getO2CHealthSummary, getARAgingBuckets, getDSOPerCustomer, getCreditExposure, getCancellationRateByCustomer, getCurrencyAnalysis, getCrossDomainSummary, getOrderValueDistribution, getDeliveryStatusBreakdown, getIncotermsAnalysis, getArchivingVsBlockedAnalysis, getDeliveryLeadTime, getHighValueOrders, getDebitCreditTotals, getSingleCustomerProducts |
| DETECT | 20 | findBrokenFlows, getFullAnomalyReport, getCancelledAfterPayment, getDeliveryFulfillmentRate, getBlockedCustomersWithOrders, getOverdueDeliveries, getCustomerOrderRecency, getFIPostingGaps, getUnpaidActiveBillingDocs |
| COMPARE | 2 | compareCustomerRevenue, compareCustomerOrders |

Every function uses parameterized Cypher with typed inputs. No string concatenation, no injection surface.

### Key Analytical Functions

| Function | Business Value |
|---|---|
| getOrderToPaymentCycleTime | Full O2C cycle time per customer: avg days from order creation to payment clearing. Identifies slowest payers. |
| getPaymentsWithoutJournalEntries | Reconciliation gap detector: payments received but no journal entry posted. |
| getDeliveriesNotBilled | Revenue leakage detector: goods shipped but no invoice raised. |
| getArchivingVsBlockedAnalysis | Compare archived vs blocked business partners: counts, overlap, and customers with neither flag. |
| getIncotermsAnalysis | Incoterms classification + location analysis via CustomerSalesArea join. |
| getCancelledInvoicesSummary | Cancelled invoice analysis with totals and sample IDs. |
| getPaymentsCollectedThisMonth/LastMonth | Dynamic month-bounded payment collection totals. |
| getSystemPipelineDescription | Meta-system introspection: explains how the NL-to-Cypher pipeline works with scoped examples. |

---

## Why Neo4j Over SQL

The O2C flow is a chain: Customer → Order → Items → Deliveries → Billing → Journal Entries → Payments.

In SQL, tracing this requires 6+ JOINs:
```sql
SELECT * FROM orders o
  JOIN order_items oi ON o.id = oi.order_id
  JOIN deliveries d ON oi.id = d.item_id
  JOIN billings b ON d.id = b.delivery_id
  JOIN journals j ON b.id = j.billing_id
  JOIN payments p ON j.id = p.journal_id
WHERE o.id = '740556'
```

In Neo4j, the same query is a single graph traversal:
```cypher
MATCH (so:SalesOrder {salesOrder:'740556'})-[:HAS_ITEM]->(soi)
      -[:FULFILLED_BY]->(di)-[:PART_OF]->(dh)
      -[:BILLED_IN]->(bi)-[:PART_OF]->(bh)
      -[:POSTED_AS]->(je)
OPTIONAL MATCH (bh)-[:PAID_BY]->(pay)
RETURN so, dh, bh, je, pay
```

The graph model also makes anomaly detection trivial: "Find orders with no deliveries" is simply matching nodes that lack a specific outgoing relationship — a native graph operation.

---

## Data Model

19 SAP collections ingested as graph nodes with 18 relationship types:

```
Customer -[:PLACED]-> SalesOrder -[:HAS_ITEM]-> SalesOrderItem
  |                                    |
  |                              [:REFERENCES]-> Product -[:STOCKED_AT]-> ProductPlant
  |                                    |              |
  |                              [:FULFILLED_BY]-> DeliveryItem -[:PART_OF]-> DeliveryHeader
  |                                    |              |                              |
  |                              [:HAS_SCHEDULE_LINE]  |                     [:AT_PLANT]-> Plant
  |                                    |              |
  |                              ScheduleLine         |
  |                                                   |
  [:HAS_ADDRESS]-> Address                            |
  [:ASSIGNED_TO_COMPANY]-> CustomerCompany            |
  [:SELLS_THROUGH]-> CustomerSalesArea                |

DeliveryHeader -[:BILLED_IN]-> BillingItem -[:PART_OF]-> BillingHeader
                                                              |
                                                        [:POSTED_AS]-> JournalEntry
                                                        [:PAID_BY]-> Payment
                                                              |
                                              BillingCancellation -[:CANCELS]-> BillingHeader

Product -[:DESCRIPTION_IN]-> ProductDescription

ProductPlant -[:IN_PLANT]-> Plant
ProductStorageLocation -[:FOR_PRODUCT]-> Product
```

### Node Types (19)
**Core Entities:** Customer, SalesOrder, SalesOrderItem, ScheduleLine, Product, DeliveryHeader, DeliveryItem, BillingHeader, BillingItem, BillingCancellation, JournalEntry, Payment, Plant

**Supporting Entities:** Address, CustomerCompany, CustomerSalesArea, ProductPlant, ProductStorageLocation, ProductDescription

### Key Join Decisions
- BillingHeader to JournalEntry: joined via `accountingDocument` (NOT `referenceDocument` which uses a different numbering series)
- BillingHeader to Payment: joined via `accountingDocument` (NOT `clearingAccountingDocument`)
- DeliveryItem to Plant: linked via `DeliveryItem.plant` (NOT `DeliveryHeader.shippingPoint`)

---

## Memory System

| Layer | Storage | TTL | Purpose |
|-------|---------|-----|---------|
| Conversation History | Redis (last 20 messages / 10 Q&A pairs) | 1 hour | Multi-turn context for pronoun resolution |
| Entity Memory | Redis (last 6 entity types, last-wins) | 1 hour | "Show me the order" resolves to most recently discussed order |
| Semantic Cache | Redis (cosine similarity > 0.85) | 24 hours | Skip entire pipeline for repeated/similar questions |

---

## Monitoring and Observability

The admin dashboard tracks production metrics in real time:

- Per-intent latency percentiles (p50, p95, p99)
- Cache hit rate and effectiveness
- LLM tier usage distribution
- Per-provider call counts with fallback tracking
- Error rate and blocked query count
- Estimated cost per query with monthly projections
- Function usage frequency ranking
- Token consumption with hourly/daily credit burn alerts

---

## Frontend

- Force-directed graph visualization (react-force-graph-2d) with color-coded node types
- Real-time chat interface with auto-expanding textarea (Shift+Enter for multiline)
- Node inspector panel with property details and connection list
- Resizable chat panel (drag to resize)
- Admin dashboard with metrics tables
- Dark glassmorphism UI theme

---

## Repository Structure

```
Dodge_Ai_Task/
├── README.md
├── docker-compose.yml
├── .env.example
│
├── backend/
│   ├── server.ts                 # Express API entry point
│   ├── db.ts                     # Neo4j connection
│   ├── redis.ts                  # Redis connection
│   ├── config/
│   │   └── question_plans.json   # 74 semantic routing plans (mapping to 85 functions)
│   ├── services/
│   │   ├── llm.ts                # 3-tier LLM client (Groq/DeepSeek)
│   │   ├── embedding.ts          # Domain-tuned TF-IDF embeddings
│   │   ├── graphRAG.ts           # Few-shot retrieval + live schema
│   │   ├── schemaAgent.ts        # Auto-discovers Neo4j schema
│   │   ├── questionPlans.ts      # Semantic plan matcher
│   │   ├── contractVerifier.ts   # Output validation
│   │   ├── semanticCache.ts      # Cosine similarity cache
│   │   ├── memory.ts             # Conversation + entity memory
│   │   ├── circuitBreaker.ts     # Provider failure tracking
│   │   └── metrics.ts            # Latency, cost, usage metrics
│   ├── functions/
│   │   ├── index.ts              # 85 functions across 5 intents
│   │   ├── lookup.ts             # Entity lookups
│   │   ├── traverse.ts           # Document tracing
│   │   ├── aggregate.ts          # Revenue, ranking, distribution
│   │   ├── detect.ts             # Anomaly detection
│   │   ├── compare.ts            # Customer comparisons
│   │   ├── meta.ts               # Schema introspection
│   │   └── analytics.ts          # Pre-built analytics (DSO, aging, etc.)
│   ├── graph/
│   │   ├── state.ts              # Pipeline state interface
│   │   ├── index.ts              # Pipeline orchestrator
│   │   └── nodes/                # 6 pipeline nodes
│   └── routes/
│       ├── chat.ts               # Chat API
│       ├── graph.ts              # Graph visualization
│       └── admin.ts              # Metrics dashboard
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx               # Main app with routing
│   │   ├── index.css             # Dark glassmorphism theme
│   │   └── components/
│   │       ├── GraphView.tsx     # Force-directed graph
│   │       ├── ChatPanel.tsx     # Chat interface
│   │       ├── NodeInspector.tsx  # Node details
│   │       └── AdminPanel.tsx    # Metrics dashboard
│
└── sap-o2c-data/                 # Source SAP data (19 JSONL collections)
```

---

## Docker

```bash
# Build and start everything
docker-compose up --build

# Run in background
docker-compose up -d --build

# View backend logs
docker-compose logs -f backend

# Stop
docker-compose down
```

| Service | Image | Port | Notes |
|---------|-------|------|-------|
| backend | Node 20 Alpine (multi-stage build) | 3001 | Health check on /health |
| frontend | Nginx Alpine (multi-stage build) | 80 | SPA routing + API proxy |

---

## How to Run Locally

### Prerequisites
- Node.js 18+
- Neo4j Aura free tier account
- Redis Cloud free tier account
- API keys: Groq, DeepSeek (all free tier)

### Setup

```bash
# 1. Clone and install
git clone <repo-url>
cd Dodge_Ai_Task

# 2. Install dependencies
cd backend && npm install
cd ../frontend && npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 4. Build and ingest data
cd backend
npx tsc
npm run ingest

# 5. Start backend
node dist/server.js
# Running on http://localhost:3001

# 6. Start frontend (new terminal)
cd frontend
npm run dev
# Running on http://localhost:5173
```

### With Docker
```bash
docker-compose up --build
# Frontend: http://localhost
# Backend API: http://localhost:3001
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | React 18 + Vite + TypeScript | Fast HMR, type safety |
| Graph Visualization | react-force-graph-2d | WebGL-accelerated force-directed layouts |
| Backend | Node.js + Express + TypeScript | Type-safe API layer |
| Pipeline | LangGraph (6-node optimized) | Deterministic state machine with typed state |
| Graph DB | Neo4j Aura (cloud, free tier) | Native graph traversals for O2C chains |
| Cache/Memory | Redis Cloud (free tier) | Sub-ms reads, TTL expiry, semantic cache |
| LLM Providers | Groq + DeepSeek (free tier) | Zero-cost with mutual fallback chain |
| Embeddings | Domain-tuned TF-IDF | Synonym normalization, zero API cost, no native deps |
| Containerization | Docker + Docker Compose | Multi-stage builds, health checks |

---

## Known Limitations

| Limitation | Mitigation |
|---|---|
| Novel prompt coverage depends on plan examples | Semantic router + keyword + cross-intent LLM fallback + smart fallback to nearest function |
| Historical dataset (April 2025) vs current date | Context-aware error messages explain date range |
| Complex multi-hop queries (6+ nodes) via LLM Cypher | Pre-built functions for critical patterns + query decomposition + escalating retries |
| Dynamic Cypher field names vs contract schemas | Contract verification skipped for dynamic Cypher; best-results fallback |
| Answer formatting accuracy | 20+ deterministic templates for known functions; post-LLM validation for novel queries |
| SAP field name ambiguity | SAP field mapping hints guide the LLM to correct fields |
| Schema Agent startup time (~20s) | Graceful fallback to hardcoded schemas if agent fails |
