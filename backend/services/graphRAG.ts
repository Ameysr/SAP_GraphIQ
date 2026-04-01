// ── GraphRAG: Few-Shot Retriever + Schema Selector ────────────────────────────
// Production-grade: Embeds curated query library at startup, retrieves top-K
// similar examples at query time, and builds a mini-schema for the LLM.

import { getLocalEmbedding } from './embedding.js';
import { cosineSimilarity } from '../utils/math.js';
import { QUERY_LIBRARY, type QueryExample } from './queryLibrary.js';

// ── SCHEMA FRAGMENTS ──────────────────────────────────────────────────────────
// Each node type's schema as a string — only the relevant ones are sent to LLM
const NODE_SCHEMAS: Record<string, string> = {
  Customer: 'Customer {id(string, e.g. "320000083"), businessPartnerFullName(string), businessPartnerName(string), businessPartnerIsBlocked(boolean), customer(string), creationDate(string)}',
  SalesOrder: 'SalesOrder {id(string), salesOrder(string, e.g. "740586"), soldToParty(string = customer id), totalNetAmount(string — use toFloat()), transactionCurrency(string, e.g. "INR"), salesOrganization(string, e.g. "IN01"), creationDate(string, e.g. "2025-04-10"), overallDeliveryStatus(string), overallOrdReltdBillgStatus(string), customerPaymentTerms(string, e.g. "Z001"/"Z009"), incotermsClassification(string), distributionChannel(string), requestedDeliveryDate(string)}',
  SalesOrderItem: 'SalesOrderItem {id(string = salesOrder_salesOrderItem), salesOrder(string), salesOrderItem(string, e.g. "10"), material(string), netAmount(string — use toFloat()), materialGroup(string)}',
  ScheduleLine: 'ScheduleLine {id(string), salesOrder(string), salesOrderItem(string), scheduleLine(string), confirmedDeliveryDate(string)}',
  Product: 'Product {id(string), product(string, e.g. "MZ-FG-S300"), productDescription(string), productGroup(string)}',
  DeliveryHeader: 'DeliveryHeader {id(string), deliveryDocument(string, e.g. "800066830"), creationDate(string), deliveryDate(string), shippingPoint(string), overallGoodsMovementStatus(string, "A"=not moved, "C"=complete)}',
  DeliveryItem: 'DeliveryItem {id(string), deliveryDocument(string), deliveryDocumentItem(string), plant(string, e.g. "WB05"), referenceSdDocument(string = original salesOrder), actualDeliveryQuantity(string)}',
  BillingHeader: 'BillingHeader {id(string), billingDocument(string, e.g. "91150188"), billingDocumentType(string — F2=invoice, S1=cancellation), totalNetAmount(string — use toFloat()), transactionCurrency(string), billingDocumentDate(string), accountingDocument(string), soldToParty(string = customer id), billingDocumentIsCancelled(boolean)}',
  BillingItem: 'BillingItem {id(string), billingDocument(string), billingDocumentItem(string), material(string), netAmount(string — use toFloat()), referenceSdDocument(string)}',
  BillingCancellation: 'BillingCancellation {id(string), billingDocument(string), cancelledBillingDocument(string), totalNetAmount(string)}',
  JournalEntry: 'JournalEntry {id(string), accountingDocument(string), accountingDocumentItem(string), glAccount(string), amountInTransactionCurrency(string — use toFloat())}',
  Payment: 'Payment {id(string), accountingDocument(string), accountingDocumentItem(string), clearingDate(string), amountInTransactionCurrency(string — use toFloat()), customer(string)}',
  Plant: 'Plant {id(string), plant(string, e.g. "WB05"), plantName(string)}',
  Address: 'Address {id(string), businessPartner(string), cityName(string), country(string), postalCode(string)}',
  CustomerCompany: 'CustomerCompany {id(string), customer(string), companyCode(string)}',
  CustomerSalesArea: 'CustomerSalesArea {id(string), customer(string), salesOrganization(string)}',
  ProductPlant: 'ProductPlant {id(string), product(string), plant(string), profitCenter(string)}',
  ProductDescription: 'ProductDescription {id(string), product(string), language(string), productDescription(string)}',
  ProductStorageLocation: 'ProductStorageLocation {id(string), product(string), plant(string), storageLocation(string)}',
};

// Relationships that involve specific node types
const RELATIONSHIP_MAP: Record<string, string[]> = {
  Customer: ['(Customer)-[:PLACED]->(SalesOrder)', '(Customer)-[:HAS_ADDRESS]->(Address)', '(Customer)-[:ASSIGNED_TO_COMPANY]->(CustomerCompany)', '(Customer)-[:SELLS_THROUGH]->(CustomerSalesArea)'],
  SalesOrder: ['(Customer)-[:PLACED]->(SalesOrder)', '(SalesOrder)-[:HAS_ITEM]->(SalesOrderItem)'],
  SalesOrderItem: ['(SalesOrder)-[:HAS_ITEM]->(SalesOrderItem)', '(SalesOrderItem)-[:HAS_SCHEDULE_LINE]->(ScheduleLine)', '(SalesOrderItem)-[:REFERENCES]->(Product)', '(SalesOrderItem)-[:FULFILLED_BY]->(DeliveryItem)'],
  ScheduleLine: ['(SalesOrderItem)-[:HAS_SCHEDULE_LINE]->(ScheduleLine)'],
  Product: ['(SalesOrderItem)-[:REFERENCES]->(Product)', '(Product)-[:STOCKED_AT]->(ProductPlant)', '(Product)-[:HAS_DESCRIPTION]->(ProductDescription)'],
  DeliveryHeader: ['(DeliveryItem)-[:PART_OF]->(DeliveryHeader)', '(DeliveryHeader)-[:BILLED_IN]->(BillingItem)'],
  DeliveryItem: ['(SalesOrderItem)-[:FULFILLED_BY]->(DeliveryItem)', '(DeliveryItem)-[:PART_OF]->(DeliveryHeader)', '(DeliveryItem)-[:AT_PLANT]->(Plant)'],
  BillingHeader: ['(BillingItem)-[:PART_OF]->(BillingHeader)', '(BillingHeader)-[:POSTED_AS]->(JournalEntry)', '(BillingHeader)-[:PAID_BY]->(Payment)', '(BillingCancellation)-[:CANCELS]->(BillingHeader)'],
  BillingItem: ['(DeliveryHeader)-[:BILLED_IN]->(BillingItem)', '(BillingItem)-[:PART_OF]->(BillingHeader)'],
  BillingCancellation: ['(BillingCancellation)-[:CANCELS]->(BillingHeader)'],
  JournalEntry: ['(BillingHeader)-[:POSTED_AS]->(JournalEntry)'],
  Payment: ['(BillingHeader)-[:PAID_BY]->(Payment)'],
  Plant: ['(DeliveryItem)-[:AT_PLANT]->(Plant)', '(ProductPlant)-[:IN_PLANT]->(Plant)'],
  Address: ['(Customer)-[:HAS_ADDRESS]->(Address)'],
  CustomerCompany: ['(Customer)-[:ASSIGNED_TO_COMPANY]->(CustomerCompany)'],
  CustomerSalesArea: ['(Customer)-[:SELLS_THROUGH]->(CustomerSalesArea)'],
  ProductPlant: ['(Product)-[:STOCKED_AT]->(ProductPlant)', '(ProductPlant)-[:IN_PLANT]->(Plant)'],
  ProductDescription: ['(Product)-[:HAS_DESCRIPTION]->(ProductDescription)'],
  ProductStorageLocation: ['(ProductStorageLocation)-[:FOR_PRODUCT]->(Product)'],
};

// Critical notes that are always included
const CRITICAL_NOTES = `
CRITICAL RULES:
- Amount fields (totalNetAmount, netAmount, amountInTransactionCurrency) are STRINGS. Always use toFloat() before SUM/comparison.
- Boolean fields (businessPartnerIsBlocked, billingDocumentIsCancelled) are actual booleans: use = true / = false.
- Customer ID links: Customer.id = SalesOrder.soldToParty = BillingHeader.soldToParty = Payment.customer
- REVENUE = active (non-cancelled) BillingHeader.totalNetAmount. NEVER use SalesOrder amounts for revenue.
- When filtering active billing: WHERE bh.billingDocumentIsCancelled = false OR bh.billingDocumentIsCancelled IS NULL
- There is NO direct relationship between Customer and BillingHeader — use property match WHERE bh.soldToParty = c.id
- DeliveryItem has NO material field. To get products: (SalesOrderItem)-[:FULFILLED_BY]->(DeliveryItem) then (SalesOrderItem)-[:REFERENCES]->(Product)
- To join BillingHeader to Payment for clearing time: use Payment.accountingDocument = BillingHeader.accountingDocument
- For aggregation queries (COUNT, SUM) — put LIMIT AFTER the aggregation, NOT before
⚠️ DATASET DATE RANGE: The SAP O2C data primarily covers April 2025. Queries using date() ("today"), "this month", or "last 30 days" will likely return EMPTY results. If the user asks about "this month" or "recent", consider filtering for April 2025 instead.
⚠️ USE ONLY THE RELATIONSHIPS LISTED BELOW. DO NOT INVENT NEW ONES.`;

// ── EMBEDDING INDEX ───────────────────────────────────────────────────────────
let libraryEmbedded = false;

const CONTEXT_CACHE_TTL_MS = parseInt(process.env.GRAPHRAG_CONTEXT_CACHE_TTL_MS ?? '600000', 10); // 10 min
const CONTEXT_CACHE_MAX = parseInt(process.env.GRAPHRAG_CONTEXT_CACHE_MAX ?? '100', 10);
const contextCache = new Map<string, { value: GraphRAGContext; expiresAt: number }>();

function embedLibrary(): void {
  if (libraryEmbedded) return;
  console.log(`  [GraphRAG] Embedding ${QUERY_LIBRARY.length} curated examples...`);
  for (const example of QUERY_LIBRARY) {
    example.embedding = getLocalEmbedding(example.question);
  }
  libraryEmbedded = true;
  console.log(`  [GraphRAG] Library embedded (TF-IDF) \u2713`);
}





// ── PUBLIC API ────────────────────────────────────────────────────────────────

export interface GraphRAGContext {
  fewShotExamples: string;      // Formatted few-shot Cypher examples
  schemaSubset: string;          // Only relevant node types + relationships
  matchedExamples: string[];     // Which examples were matched (for logging)
}

/**
 * Retrieve the top-K most similar curated examples + build a targeted schema context.
 * This replaces the 135-line full schema with a focused 30-50 line mini-schema.
 */
export async function retrieveContext(question: string, topK: number = 5): Promise<GraphRAGContext> {
  embedLibrary();

  const cacheKey = `${question.trim().toLowerCase()}|topK=${topK}`;
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const queryEmb = getLocalEmbedding(question);
  
  // Score all examples
  const scored = QUERY_LIBRARY
    .filter(ex => ex.embedding)
    .map(ex => ({ example: ex, score: cosineSimilarity(queryEmb, ex.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  console.log(`  [GraphRAG] Top-${topK} matches:`);
  for (const { example, score } of scored) {
    console.log(`    ${score.toFixed(3)} → "${example.question.substring(0, 60)}..."`);
  }

  // ── BUILD FEW-SHOT EXAMPLES ──
  const fewShotExamples = scored
    .map(({ example }, i) => 
      `Example ${i + 1}:\nQ: "${example.question}"\nCypher: ${example.cypher}`)
    .join('\n\n');

  // ── BUILD SCHEMA SUBSET ──
  // Collect all node types from the matched examples
  const relevantNodes = new Set<string>();
  for (const { example } of scored) {
    for (const node of example.schemaNodes) {
      relevantNodes.add(node);
    }
  }
  
  // Always include Customer (it's the anchor of most queries)
  relevantNodes.add('Customer');

  // Build mini-schema
  const nodeLines = Array.from(relevantNodes)
    .filter(n => NODE_SCHEMAS[n])
    .map(n => `- ${NODE_SCHEMAS[n]}`);

  // Collect relevant relationships (deduplicated)
  const relSet = new Set<string>();
  for (const node of relevantNodes) {
    const rels = RELATIONSHIP_MAP[node] ?? [];
    for (const rel of rels) {
      relSet.add(rel);
    }
  }

  const schemaSubset = `Node types (ONLY these are relevant to this query):
${nodeLines.join('\n')}

Relationships:
${Array.from(relSet).join('\n')}

${CRITICAL_NOTES}`;

  const ctx: GraphRAGContext = {
    fewShotExamples,
    schemaSubset,
    matchedExamples: scored.map(s => s.example.question),
  };

  contextCache.set(cacheKey, { value: ctx, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
  if (contextCache.size > CONTEXT_CACHE_MAX) {
    // Map preserves insertion order; remove oldest entries first.
    const oldestKey = contextCache.keys().next().value as string | undefined;
    if (oldestKey) contextCache.delete(oldestKey);
  }

  return ctx;
}
