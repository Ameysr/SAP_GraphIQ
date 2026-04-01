# SAP Order to Cash Graph Intelligence System

An enterprise grade, AI powered analytical engine that models the SAP Order to Cash process as a knowledge graph and answers complex business questions through a multi tier LLM pipeline with deterministic guardrails.

This is not a simple chatbot wrapper. Every design decision was made to solve real production problems: LLM hallucination, cost control, query safety, response verification, and system resilience.

> **Note:** This project was an assignment with a deadline of March 26th. I continued optimizing it because I treated it as a real production accuracy problem and found it genuinely interesting to solve. The work after the 26th (semantic embeddings, query decomposition, escalating retries, deterministic answer templates) was driven purely by curiosity — feel free to consider only the March 26th snapshot if needed.
>
> **Live Demo:** [https://dodge-ai-task-lilac.vercel.app/](https://dodge-ai-task-lilac.vercel.app/)

---

## What Makes This Production Grade

### 1. Deterministic Query Routing
72 pre built, typed Cypher functions handle known query patterns across 5 intents (LOOKUP, TRAVERSE, AGGREGATE, DETECT, COMPARE). The LLM only selects which function to call and fills parameters — no raw Cypher generation, no hallucinated data, no injection attacks. A semantic similarity router powered by **domain-tuned TF-IDF embeddings** (90+ dimension SAP O2C vocabulary with synonym normalization and phrase boosting) hard locks the query to a hardcoded function before the LLM even sees it.

### 2. Smart Fallback System
When dynamic Cypher generation fails after all retries, the system does not return "no data found." Instead, it scans plan candidates for the nearest plan with a real pre built function, executes it, and prefixes the answer with transparency: *"I couldn't answer your exact question directly, but here's the closest available analysis."* This is the industry standard approach used by SAP Analytics Cloud match to the nearest available report rather than silently fail.

### 3. GraphRAG with Few Shot Retrieval
For novel questions outside the function library, the system embeds the user question, retrieves the top K most similar Cypher examples from a curated 60 query library, builds a minimal schema subset relevant to the question, and sends everything as context to the LLM a structured retrieval pipeline, not a raw prompt.

### 4. Context Aware Error Handling
When queries return zero results, the system provides targeted feedback instead of generic "try rephrasing" messages:
- **Date queries:** "No records found for this time period. The dataset covers April 2025. Try asking about a specific date range."
- **Entity queries:** "No records found for Customer: 310000109. Verify the ID exists."
- **General:** "The search criteria may be too specific. Try broadening your question."

### 5. Contract Verification
Pre built function results are verified against a data contract: required fields, numeric ranges, sort monotonicity, ratio consistency. Critically, the system distinguishes between pre built function results (contract verified) and dynamic Cypher results (contract skipped, since ad hoc Cypher produces field names that never match static schemas). On failure, a best-results fallback restores the strongest earlier attempt instead of returning nothing.

### 6. Schema and Meta System Intelligence
Conceptual questions about the graph schema ("What edge connects SalesOrder to DeliveryItem?") and meta system questions ("How does your NL system translate a query?") are detected before plan routing and routed to dedicated functions. This prevents false positive plan matches where schema keywords like "SalesOrder" or "relationship" would incorrectly trigger data retrieval plans.

### 7. Deterministic Answer Templates
For 17+ known functions, answers are produced with **zero LLM involvement**  eliminating number hallucination entirely. The system uses pre-built markdown templates that directly format query results (e.g., AR aging buckets, DSO days, credit exposure) with correct currency symbols, percentages, and counts. LLM formatting is only used as a fallback for novel queries.

### 8. Query Decomposition
Complex multi part questions ("Show revenue AND delivery rates AND aging buckets for all customers") are automatically detected and split into 2 4 independent sub-queries. Each sub-query gets its own GraphRAG context, Cypher generation, and execution. Results are tagged and merged before answer formatting. Detection uses heuristics: 3+ conjunctions, multiple question marks, 4+ metric keywords.

### 9. Escalating Retry Strategy
When Cypher generation fails, each retry uses a **fundamentally different approach** instead of repeating the same context:

| Retry | Strategy | LLM Tier | Change |
|-------|----------|----------|--------|
| 0 | Standard generation | Tier 2 | 5 GraphRAG examples |
| 1 | Forced CoT + error analysis | Tier 2 | 7 examples, must write fundamentally different query |
| 2 | Simplified approach | **Tier 3** (deepseek-reasoner) | Aggressive simplification, 1-2 MATCH clauses only |
| 3 | Query decomposition | Tier 2 | Breaks question into 2-4 sub-queries |

### 10. Schema-Aware Cypher Validation
Before executing LLM-generated Cypher, the system validates it against the known graph schema: checks node labels against 16 valid types, relationship types against 16 valid edges, and detects missing `toFloat()` on amount fields. Invalid queries are caught before hitting Neo4j, saving round-trips and improving retry quality.

### 11. Multi-Layer Memory
Redis backed conversation history (last 10 messages) + entity memory resolve pronouns across turns: *"Show me the order"* resolves to the exact ID discussed moments ago. Semantic cache (cosine similarity > 0.85) skips the full pipeline for repeated or similar questions.

### 12. Multi Layer Security
Input sanitization strips Cypher injection attempts (`CREATE`, `DELETE`, `DROP`, `MERGE`). Rate limiting caps requests at 10/minute per IP. The guardrail node rejects off topic queries before any database access. Entity extraction uses regex, not LLM, to prevent prompt injection through entity names.

### 13. Resilient Data Ingestion
The ingestion script processes 19 SAP collections in two passes (nodes first, relationships second) with configurable batch sizes. A resume script handles single record transactions with auto pause on connection errors, ensuring 16,000+ records complete even on constrained infrastructure.

---

## Repository Structure

```
Dodge_Ai_Task/
├── README.md                 # This file - setup instructions and architecture overview
├── docker-compose.yml        # Docker orchestration for frontend + backend
├── .env.example              # Environment variables template
├── .gitignore                # Git ignore rules
│
├── backend/                  # Node.js + TypeScript backend
│   ├── Dockerfile            # Multi-stage build for production
│   ├── server.ts             # Express API entry point
│   ├── db.ts                 # Neo4j database connection
│   ├── redis.ts              # Redis connection for caching/memory
│   ├── package.json          # Dependencies and scripts
│   ├── tsconfig.json         # TypeScript configuration
│   ├── config/
│   │   └── question_plans.json    # 61 semantic routing plans
│   ├── scripts/
│   │   ├── ingest.ts         # Data ingestion script (JSONL → Neo4j)
│   │   └── resume-ingest.ts  # Resilient ingestion for large datasets
│   ├── services/
│   │   ├── llm.ts            # 3-tier LLM client (Groq/DeepSeek with mutual fallback)
│   │   ├── embedding.ts      # Domain-tuned TF-IDF embeddings (90+ dim SAP O2C vocabulary)
│   │   ├── graphRAG.ts       # Few-shot retrieval + schema selection
│   │   ├── questionPlans.ts  # Semantic plan matcher
│   │   ├── contractVerifier.ts # Output validation
│   │   ├── semanticCache.ts  # Cosine similarity cache
│   │   ├── memory.ts         # Conversation history + entity memory
│   │   ├── circuitBreaker.ts # LLM provider failure tracking
│   │   ├── metrics.ts        # Latency, cost, usage metrics
│   │   └── logger.ts         # Observability logging
│   ├── functions/
│   │   ├── index.ts          # 72 Cypher functions across 5 intents
│   │   ├── lookup.ts         # Entity lookups (Customer, Order, Product, etc.)
│   │   ├── traverse.ts       # Document tracing across O2C chain
│   │   ├── aggregate.ts      # Revenue, ranking, distribution analytics
│   │   ├── detect.ts         # Anomaly detection (broken flows, unpaid invoices)
│   │   ├── compare.ts        # Head-to-head customer comparisons
│   │   ├── meta.ts           # Schema introspection, pipeline description
│   │   └── analytics.ts     # Pre-built analytics (DSO, aging, credit, etc.)
│   ├── graph/
│   │   ├── state.ts          # LangGraph pipeline state interface
│   │   ├── index.ts          # Pipeline orchestrator with smart retry + decomposition
│   │   └── nodes/
│   │       ├── contextResolution.ts  # Pronoun resolution via memory
│   │       ├── guardrail.ts          # Guardrail + intent + complexity
│   │       ├── entityExtractor.ts    # Regex-based entity extraction
│   │       ├── functionSelector.ts   # Plan router + LLM selection
│   │       ├── hybridExecutor.ts     # Function call OR dynamic Cypher + escalating retries
│   │       ├── answerFormatter.ts    # Deterministic templates + LLM fallback
│   │       └── queryDecomposer.ts    # Complex query decomposition engine
│   ├── routes/
│   │   ├── chat.ts           # Chat API endpoint
│   │   ├── graph.ts          # Graph visualization data
│   │   └── admin.ts          # Metrics dashboard endpoint
│   └── tests/
│       └── accuracy.test.ts  # Automated accuracy tests
│
├── frontend/                 # React + Vite + TypeScript frontend
│   ├── Dockerfile            # Multi-stage build (React → Nginx)
│   ├── nginx.conf            # SPA routing + API proxy config
│   ├── package.json          # Frontend dependencies
│   ├── vite.config.ts        # Vite build configuration
│   ├── index.html            # HTML entry point
│   └── src/
│       ├── main.tsx          # React entry point
│       ├── App.tsx           # Main app with routing
│       ├── index.css         # Dark glassmorphism theme
│       ├── components/
│       │   ├── GraphView.tsx        # Force-directed graph visualization
│       │   ├── ChatPanel.tsx        # Chat interface
│       │   ├── FormattedMessage.tsx  # Markdown-formatted message renderer
│       │   ├── NodeInspector.tsx    # Node detail panel
│       │   └── AdminPanel.tsx       # Metrics dashboard
│       └── hooks/
│           ├── useGraph.ts       # Graph data fetching
│           └── useChat.ts        # Chat state management
│
├── sap-o2c-data/             # Source SAP data (19 JSONL collections)
│   ├── sales_order_headers/
│   ├── sales_order_items/
│   ├── outbound_delivery_headers/
│   ├── outbound_delivery_items/
│   ├── billing_document_headers/
│   ├── billing_document_items/
│   └── ... (13 more collections)
│
└── data/                     # Working copy for ingestion (auto-generated)
    └── ... (copied from sap-o2c-data during setup)
```

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
    [LangGraph Pipeline - 6 Nodes]         [Rate Limiter]
               |                           [Input Sanitizer]
    1. Context Resolution (regex, 0 LLM)
    2. Guardrail + Intent + Complexity (keyword-first, 0 or 1 LLM)
    3. Entity Extraction (regex, 0 LLM)
    4. Plan Router + Function Selector (plan + entity + LLM fallback)
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

Each query passes through 6 sequential nodes. This is an industry aligned pipeline design: guardrail, intent, and complexity classification are merged into a single LLM call, eliminating 2 redundant nodes from the original 8 node design and reducing max LLM calls from 4 to 3.

| Node | What It Does | Why It Exists |
|------|-------------|---------------|
| Context Resolution | Resolves pronouns using conversation history and entity memory | "Show me the order" becomes "Show me order 740556" based on what was discussed |
| Guardrail + Intent + Complexity | Single merged node: keyword rules first (0 LLM), then one LLM call returns relevance, intent, complexity, and tier. Detects schema/conceptual questions and routes them to dedicated functions before plan matching. | One call replaces three old nodes. 80% of queries resolved by keywords at 0ms. Schema questions bypass plan routing entirely to avoid false positives. |
| Entity Extraction | Regex extracts IDs, names, dates from the question. Entities are automatically injected into function params via entity-to-param mapping. | Avoids LLM call for structured extraction. Regex is faster, cheaper, deterministic. Entity injection ensures functions like getOrdersPlacedByCustomer(customerId) receive the extracted ID. |
| Plan Router + Function Selector | Plan similarity (61 plans, hard lock for critical + soft recommendation at 0.72 threshold), then entity-specific shortcuts, then LLM fallback | Three-tier routing ensures the right function is selected. Threshold at 0.72 to eliminate false-positive plan matches. |
| Hybrid Executor | Runs hardcoded function OR generates Cypher dynamically with GraphRAG context. Escalating retries: Tier 2 → Tier 2+CoT → Tier 3 → Query decomposition. Schema-aware validation catches wrong labels/relationships before execution. | If function exists: guaranteed correct. If not: LLM generates Cypher with few-shot examples, targeted schema, and explicit type conversion rules. Each retry escalates strategy instead of repeating. |
| Answer Formatter | Deterministic templates for 17+ known functions (zero LLM, zero hallucination). LLM formatting only for novel queries with result sanitization and post-LLM validation. | Template path: exact numbers, correct currency/count formatting. LLM path: contract verification, field-type guards, result deduplication. |

### Escalating Retry Loop

If the executor fails (bad Cypher, empty results), it does not just error out or repeat the same approach:

1. **Retry 1:** Forces mandatory chain-of-thought reasoning + explicit root cause diagnosis. Retrieves 7 GraphRAG examples (up from 5). Demands a fundamentally different query approach.
2. **Retry 2:** Escalates to Tier 3 (deepseek-reasoner) — the most powerful model. Forces aggressive simplification: 1-2 MATCH clauses, OPTIONAL MATCH everywhere.
3. **Retry 3:** Abandons single-query approach entirely. Uses **query decomposition** to break the question into 2-4 independent sub-queries, executes each separately, and merges results.
4. Best results from any attempt are saved — if later attempts fail, earlier successful results are restored.
5. If all retries fail, the smart fallback system finds the nearest working pre-built function and executes it with transparency.

---

## Question Plan System

61 question plans define the system's analytical capabilities. Each plan has:

- Semantic routing examples (3-7 per plan) matched using **domain-tuned TF-IDF embeddings** (90+ dimension SAP O2C vocabulary with synonym normalization and phrase boosting)
- A target function name for deterministic execution (all 61 plans now have real functions — zero null-function plans)
- A data contract for output verification
- A criticality flag that locks the plan when matched (no LLM override)
- Entity-to-param auto injection (extracted IDs are automatically merged into function params)

Plans cover billing analytics, revenue ranking, payment analysis, anomaly detection, customer profiling, delivery tracking, AR aging, DSO, credit exposure, order to cash cycle time, revenue leakage detection, reconciliation gaps, and cross domain summaries.

For truly novel questions (no plan match, no keyword match), the system falls through to GraphRAG: vector retrieves similar query examples, builds a mini schema, and lets the LLM generate Cypher dynamically. If even this fails, the smart fallback executes the nearest available pre built function with user transparency.

---

## LLM Tiering Strategy

| Tier | Primary | Fallback | When Used |
|------|---------|----------|-----------|
| 1 | Groq LLaMA 3.3 70B | DeepSeek Chat | Guardrail, intent classification |
| 2 | DeepSeek Chat | Groq LLaMA 3.3 70B | Function selection, Cypher generation, answer formatting |
| 3 | DeepSeek Reasoner | Groq LLaMA 3.3 70B | Complex multi-hop queries (DETECT, COMPARE) |
| Embed | Domain-tuned TF-IDF | N/A (deterministic) | Plan routing, GraphRAG retrieval, semantic cache | Zero API cost, no native dependencies |

DeepSeek Reasoner produces a chain of thought block before answering, improving accuracy on complex queries by reasoning through relationship directions and join keys before generating Cypher. The think block is stripped before JSON parsing.

Circuit breakers track per-provider failure rates. If a provider fails 3 times consecutively, it is temporarily bypassed and the fallback is used directly.

---

## Evaluation Results

```
  Accuracy        92%    useful-answer rate (correct + partial)
  Exact Match     80%    numeric/entity-level precision
  Avg Latency     1.8s   deterministic path (pre-built function)
  Avg Latency    12.4s   dynamic path (LLM-generated Cypher)
  LLM Cost       $0.00   all providers on free tier
```

Evaluated against a mixed suite of 25 queries spanning 5 categories:

| Category | Queries | Accuracy | Method |
|---|---|---|---|
| Deterministic KPIs (billing totals, entity counts) | 8 | 100% | Pre-built functions with contract verification |
| Multi-hop traversals (order-to-cash chains) | 5 | 80% | Deterministic trace functions |
| Anomaly detection (broken flows, cancellations) | 5 | 80% | Pre-built detect functions + smart fallback |
| Schema and meta-system questions | 4 | 100% | Dedicated schema/meta routing bypass |
| Novel analytical queries (dynamic Cypher) | 3 | 67% | GraphRAG few-shot generation |

Scoring: **Fully correct** = numeric/entity-level match with expected logic. **Partially correct** = useful direction but misses one element. **Incorrect** = wrong function path or unrelated output.

---

## Function Library

72 hardcoded Cypher functions organized by intent:

| Intent | Count | Examples |
|--------|-------|----------|
| LOOKUP | 5 | getCustomer, getOrder, getProduct, getBillingDoc, getDelivery |
| TRAVERSE | 8 | traceDocument, traceOrderJourney, getBusinessPartnerToBillingDocumentPath, getO2CGraphSchemaDesign |
| AGGREGATE | 38 | getRevenueConcentration, getPlantRevenueRanking, getActiveBillingTotals, getO2CHealthSummary, getARAgingBuckets, getDSOPerCustomer, getCreditExposure, getCancellationRateByCustomer, getCurrencyAnalysis, getCrossDomainSummary, getOrderValueDistribution, getDeliveryStatusBreakdown, getIncotermsAnalysis, getDeliveryLeadTime, getHighValueOrders, getDebitCreditTotals, getSingleCustomerProducts |
| DETECT | 19 | findBrokenFlows, getFullAnomalyReport, getCancelledAfterPayment, getDeliveryFulfillmentRate, getBlockedCustomersWithOrders, getOverdueDeliveries, getCustomerOrderRecency, getFIPostingGaps, getUnpaidActiveBillingDocs |
| COMPARE | 2 | compareCustomerRevenue, compareCustomerOrders |
| META | 2 | getSystemPipelineDescription, getO2CGraphSchemaDesign |

Every function uses parameterized Cypher with typed inputs. No string concatenation, no injection surface.

### Key Analytical Functions (New)

| Function | Business Value |
|---|---|
| getOrderToPaymentCycleTime | Full O2C cycle time per customer: avg days from order creation to payment clearing. Identifies slowest payers. |
| getPaymentsWithoutJournalEntries | Reconciliation gap detector: payments received but no journal entry posted. |
| getDeliveriesNotBilled | Revenue leakage detector: goods shipped but no invoice raised. |
| getCancelledInvoicesSummary | Cancelled invoice analysis with totals and sample IDs. |
| getPaymentsCollectedThisMonth/LastMonth | Dynamic month-bounded payment collection totals. |
| getSystemPipelineDescription | Meta-system introspection: explains how the NL-to-Cypher pipeline works with scoped examples. |

---

## Why Neo4j Over SQL

The O2C flow is a chain: Customer places Order, Order has Items, Items are Fulfilled by Deliveries, Deliveries are Billed, Bills generate Journal Entries, Journal Entries are Cleared by Payments.

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

The graph model also makes anomaly detection trivial: "Find orders with no deliveries" is simply matching nodes that lack a specific outgoing relationship, which is a native graph operation.

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
| Conversation History | Redis (last 10 messages) | 1 hour | Multi-turn context for pronoun resolution |
| Entity Memory | Redis (last 3 entity types, last-wins) | 1 hour | "Show me the order" resolves to most recently discussed order |
| Semantic Cache | Redis (cosine similarity > 0.85) | 24 hours | Skip entire pipeline for repeated/similar questions |

---

## Monitoring and Observability

The admin dashboard tracks production metrics in real time:

- Per intent latency percentiles (p50, p95, p99)
- Cache hit rate and effectiveness
- LLM tier usage distribution
- Per provider call counts with fallback tracking
- Error rate and blocked query count
- Estimated cost per query with monthly projections
- Function usage frequency ranking
- Token consumption with hourly/daily credit burn alerts

---

## Frontend

- Force directed graph visualization (react force graph-2d) with color coded node types
- Real time chat interface with auto expanding textarea (Shift+Enter for multiline)
- Node inspector panel with property details and connection list
- Resizable chat panel (drag to resize)
- Admin dashboard with metrics tables
- Dark glassmorphism UI theme

---

## Docker

The entire system is containerized with multi-stage builds:

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
| backend | Node 20 Alpine (multi stage: build TS then slim production) | 3001 | Health check on /health |
| frontend | Nginx Alpine (multi stage: build React then serve) | 80 | SPA routing + API proxy to backend |

The frontend Nginx config handles SPA routing, proxies /api/ requests to the backend container, enables gzip compression, and caches static assets for 7 days.

---

## How to Run Locally

### Prerequisites
- Node.js 18+
- Neo4j Aura free tier account
- Redis Cloud free tier account
- API keys: Groq, DeepSeek, Gemini (all free tier)

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
# From project root
docker-compose up --build
# Frontend: http://localhost
# Backend API: http://localhost:3001
```

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | React 18 + Vite + TypeScript | Fast HMR, type safety, modern tooling |
| Graph Visualization | react-force-graph-2d | WebGL-accelerated force-directed layouts |
| Backend | Node.js + Express + TypeScript | Type-safe API layer with middleware support |
| Pipeline | LangGraph (custom 6-node optimized pipeline) | Deterministic state machine with typed state, query decomposition, escalating retries |
| Graph DB | Neo4j Aura (cloud, free tier) | Native graph traversals for O2C chain analysis |
| Cache/Memory | Redis Cloud (free tier) | Sub-millisecond reads, TTL expiry, semantic cache |
| LLM Providers | Groq + DeepSeek (all free tier) | Zero-cost with mutual Groq↔DeepSeek fallback chain |
| Embeddings | Domain-tuned TF-IDF (90+ dim SAP O2C vocabulary) | Synonym normalization, phrase boosting, zero API cost, no native dependencies |
| Containerization | Docker + Docker Compose | Multi-stage builds, health checks, service orchestration |
---

## Known Limitations and Mitigations

| Limitation | Impact | Current Mitigation | Next Improvement |
|---|---|---|---|
| Novel prompt coverage depends on plan examples | Misrouting risk for unseen phrasing | Semantic plan router + keyword + LLM fallback + smart fallback to nearest function | Add paraphrase augmentation + periodic plan mining |
| Historical dataset (April 2025) vs current date | "Today" and "this month" queries return empty | Context-aware error messages explain date range + suggest April 2025 | Auto-detect dataset date range and rewrite temporal queries |
| Complex multi-hop queries (6+ nodes) via LLM Cypher | Under 20% first-attempt success rate for novel multi-hop queries | Pre-built functions for all critical multi-hop patterns + query decomposition + escalating retries (Tier 2 → Tier 3 → decomposition) | Expand pre-built library based on query analytics |
| Dynamic Cypher field names vs contract schemas | Contract verifier rejects valid dynamic results | Contract verification skipped for dynamic Cypher; best-results fallback | Auto-learn field name mappings from successful queries |
| Answer formatting accuracy | LLM can hallucinate numbers or misformat counts as currency | 17 deterministic answer templates for known functions (zero LLM). Post-LLM validation cross-checks numbers against actual data for novel queries. | Expand template coverage to all 72 functions |
| SAP status code interpretation (e.g., 'C' = complete vs blocked) | LLM may misinterpret domain-specific codes | Field-type hints in executor prompt with SAP-specific context | Add SAP domain glossary to system prompt |
