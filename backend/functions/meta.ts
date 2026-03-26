import { runQuery } from '../db.js';
import type { FunctionResult, QueryResult } from '../types/index.js';

function wrapResult(records: QueryResult[], funcName: string): FunctionResult {
  return { records, metadata: { count: records.length, functionName: funcName } };
}

function toIsoDateOnlyUTC(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthBoundsUTC(offsetMonths: number): { startDate: string; endDate: string; monthLabel: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths + 1, 1));
  const monthLabel = start.toISOString().slice(0, 7); // YYYY-MM
  return { startDate: toIsoDateOnlyUTC(start), endDate: toIsoDateOnlyUTC(end), monthLabel };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Q1 helper: return "business entity types" (labels) from the graph.
 * The dataset evaluation typically excludes auxiliary nodes like ProductDescription,
 * because we also denormalize that value onto Product.
 */
export async function getEntityTypesSummary(): Promise<FunctionResult> {
  const cypher = `
    MATCH (n)
    WITH DISTINCT labels(n)[0] AS nodeType
    RETURN nodeType
    ORDER BY nodeType
    LIMIT 100
  `;
  const rows = await runQuery(cypher, {});
  const rawTypes = rows
    .map((r) => String((r as Record<string, unknown>).nodeType ?? ''))
    .filter(Boolean);

  // Exclude auxiliary node types that are not considered "core entities" in the raw dataset.
  const excluded = new Set(['ProductDescription']);
  const entityTypes = rawTypes.filter((t) => !excluded.has(t));

  return wrapResult(
    [
      {
        entityTypeCount: entityTypes.length,
        entityTypes,
        excludedTypes: Array.from(excluded),
      },
    ],
    'getEntityTypesSummary'
  );
}

/**
 * Q4 helper: explain schema/ingestion join transparently.
 * This is not a DB query — it's a schema truth from ingestion logic.
 */
export async function getSalesOrderItemToDeliveryItemJoinInfo(): Promise<FunctionResult> {
  return wrapResult(
    [
      {
        edgeType: 'FULFILLED_BY',
        join: [
          {
            fromNode: 'SalesOrderItem',
            fromFields: ['salesOrder', 'salesOrderItem'],
            toNode: 'DeliveryItem',
            toFields: ['referenceSdDocument', 'referenceSdDocumentItem'],
            meaning: 'DeliveryItem.referenceSdDocument = SalesOrderItem.salesOrder AND DeliveryItem.referenceSdDocumentItem = SalesOrderItem.salesOrderItem',
          },
        ],
      },
    ],
    'getSalesOrderItemToDeliveryItemJoinInfo'
  );
}

/**
 * Explain the modeled path from BusinessPartner (Customer) to BillingDocument (BillingHeader),
 * including both graph edges and property-based joins.
 */
export async function getBusinessPartnerToBillingDocumentPath(): Promise<FunctionResult> {
  return wrapResult(
    [
      {
        fromNode: 'Customer',
        fromAlias: 'BusinessPartner',
        toNode: 'BillingHeader',
        toAlias: 'BillingDocument',
        notes: [
          'There are two common interpretations of "path":',
          '(1) a DIRECT business-key join between BusinessPartner and BillingHeader (customer → billing header)',
          '(2) the OPERATIONAL O2C process chain (order → delivery → billing).',
          'In this dataset, BillingItem.referenceSdDocument points to a DeliveryHeader.deliveryDocument (not a SalesOrder), so an order→billing-item direct hop is not generally valid.',
        ],
        paths: [
          {
            name: 'direct_business_link',
            description: 'Direct join from BusinessPartner (Customer) to BillingDocument (BillingHeader) using the billing header sold-to party field.',
            hops: [
              {
                fromNode: 'Customer',
                toNode: 'BillingHeader',
                edge: '(property join)',
                join: 'BillingHeader.soldToParty = Customer.id',
                rawFields: ['BillingHeader.soldToParty', 'Customer.id'],
              },
            ],
          },
          {
            name: 'operational_o2c_flow',
            description: 'Operational O2C chain that explains how items flow from order → delivery → billing.',
            hops: [
              {
                fromNode: 'Customer',
                toNode: 'SalesOrder',
                edge: 'PLACED',
                join: 'graph edge: (Customer)-[:PLACED]->(SalesOrder)',
                rawFields: ['SalesOrder.soldToParty', 'Customer.id'],
              },
              {
                fromNode: 'SalesOrder',
                toNode: 'SalesOrderItem',
                edge: 'HAS_ITEM',
                join: 'graph edge: (SalesOrder)-[:HAS_ITEM]->(SalesOrderItem)',
                rawFields: ['SalesOrderItem.salesOrder', 'SalesOrder.salesOrder'],
              },
              {
                fromNode: 'SalesOrderItem',
                toNode: 'DeliveryItem',
                edge: 'FULFILLED_BY',
                join: 'DeliveryItem.referenceSdDocument = SalesOrderItem.salesOrder AND DeliveryItem.referenceSdDocumentItem = SalesOrderItem.salesOrderItem',
                rawFields: [
                  'DeliveryItem.referenceSdDocument',
                  'DeliveryItem.referenceSdDocumentItem',
                  'SalesOrderItem.salesOrder',
                  'SalesOrderItem.salesOrderItem',
                ],
              },
              {
                fromNode: 'DeliveryItem',
                toNode: 'DeliveryHeader',
                edge: 'PART_OF',
                join: 'graph edge: (DeliveryItem)-[:PART_OF]->(DeliveryHeader)',
                rawFields: ['DeliveryItem.deliveryDocument', 'DeliveryHeader.deliveryDocument'],
              },
              {
                fromNode: 'DeliveryHeader',
                toNode: 'BillingItem',
                edge: 'BILLED_IN',
                join: 'BillingItem.referenceSdDocument = DeliveryHeader.deliveryDocument AND BillingItem.referenceSdDocumentItem = DeliveryItem.deliveryDocumentItem',
                rawFields: [
                  'BillingItem.referenceSdDocument',
                  'BillingItem.referenceSdDocumentItem',
                  'DeliveryHeader.deliveryDocument',
                  'DeliveryItem.deliveryDocumentItem',
                ],
              },
              {
                fromNode: 'BillingItem',
                toNode: 'BillingHeader',
                edge: 'PART_OF',
                join: 'graph edge: (BillingItem)-[:PART_OF]->(BillingHeader)',
                rawFields: ['BillingItem.billingDocument', 'BillingHeader.billingDocument'],
              },
              {
                fromNode: 'BillingHeader',
                toNode: 'Customer',
                edge: '(property join)',
                join: 'BillingHeader.soldToParty = Customer.id (not a graph edge)',
                rawFields: ['BillingHeader.soldToParty', 'Customer.id'],
              },
            ],
          },
        ],
      },
    ],
    'getBusinessPartnerToBillingDocumentPath'
  );
}

/**
 * Count DeliveryHeader overallGoodsMovementStatus split (A vs C).
 */
export async function getDeliveryGoodsMovementStatusCounts(): Promise<FunctionResult> {
  const cypher = `
    MATCH (dh:DeliveryHeader)
    WHERE dh.overallGoodsMovementStatus IN ['A','C']
    RETURN dh.overallGoodsMovementStatus AS status,
           count(DISTINCT dh) AS headerCount
    ORDER BY headerCount DESC
    LIMIT 50
  `;
  const rows = await runQuery(cypher, {});
  return wrapResult(rows, 'getDeliveryGoodsMovementStatusCounts');
}

export async function traceSalesOrderToDeliveryAndBilling(orderId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder {id: $orderId})
    OPTIONAL MATCH (di:DeliveryItem)
      WHERE di.referenceSdDocument = $orderId
    WITH so, collect(DISTINCT di.deliveryDocument) AS deliveryDocs
    OPTIONAL MATCH (bi:BillingItem)
      WHERE bi.referenceSdDocument IN deliveryDocs
    WITH so, deliveryDocs, collect(DISTINCT bi.billingDocument) AS billingDocs
    RETURN so.id AS salesOrder,
           deliveryDocs AS deliveryDocuments,
           billingDocs AS billingDocuments,
           {
             so_to_di: 'DeliveryItem.referenceSdDocument = SalesOrder.id (and referenceSdDocumentItem = SalesOrderItem.salesOrderItem for item-level)',
             di_to_bi: 'BillingItem.referenceSdDocument = DeliveryHeader.deliveryDocument (and referenceSdDocumentItem aligns to DeliveryItem.deliveryDocumentItem)',
             bi_to_bh: 'BillingItem.billingDocument = BillingHeader.id'
           } AS hopKeys
    LIMIT 1
  `;
  const rows = await runQuery(cypher, { orderId });
  return wrapResult(rows, 'traceSalesOrderToDeliveryAndBilling');
}

export async function getBillingItemsReferencingDelivery(deliveryId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (bi:BillingItem)
    WHERE bi.referenceSdDocument = $deliveryId
    RETURN bi.billingDocument AS billingDocument,
           bi.billingDocumentItem AS billingDocumentItem
    ORDER BY billingDocument, toInteger(billingDocumentItem)
    LIMIT 50
  `;
  const rows = await runQuery(cypher, { deliveryId });
  return wrapResult(rows, 'getBillingItemsReferencingDelivery');
}

export async function getProductsWithMaxPlantCoverage(): Promise<FunctionResult> {
  const cypher = `
    MATCH (p:Product)-[:STOCKED_AT]->(:ProductPlant)-[:IN_PLANT]->(pl:Plant)
    WITH p, count(DISTINCT pl) AS plantCount
    WITH max(plantCount) AS maxPlantCount
    MATCH (p2:Product)-[:STOCKED_AT]->(:ProductPlant)-[:IN_PLANT]->(pl2:Plant)
    WITH maxPlantCount, p2, count(DISTINCT pl2) AS plantCount
    WHERE plantCount = maxPlantCount
    RETURN maxPlantCount,
           count(DISTINCT p2) AS productCount,
           collect(DISTINCT p2.product)[..20] AS sampleProductIds
    LIMIT 1
  `;
  const rows = await runQuery(cypher, {});
  return wrapResult(rows, 'getProductsWithMaxPlantCoverage');
}

export async function getCustomerBilledVsPaidBalance(customerId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer {id: $customerId})
    OPTIONAL MATCH (bh:BillingHeader)
      WHERE bh.soldToParty = c.id
        AND (bh.billingDocumentIsCancelled = false OR bh.billingDocumentIsCancelled IS NULL OR bh.billingDocumentIsCancelled = 'false')
    WITH c, sum(toFloat(bh.totalNetAmount)) AS totalBilled, head(collect(DISTINCT bh.transactionCurrency)) AS currency
    OPTIONAL MATCH (p:Payment)
      WHERE p.customer = c.id
    WITH c, totalBilled, currency, sum(toFloat(p.amountInTransactionCurrency)) AS totalPaid
    RETURN c.businessPartnerFullName AS customerName,
           c.id AS customerId,
           round(totalBilled * 100) / 100.0 AS totalBilled,
           round(totalPaid * 100) / 100.0 AS totalPaid,
           round((totalBilled - totalPaid) * 100) / 100.0 AS outstandingBalance,
           currency
    LIMIT 1
  `;
  const rows = await runQuery(cypher, { customerId });
  return wrapResult(rows, 'getCustomerBilledVsPaidBalance');
}

/**
 * Find deliveries that were completed (goods issued) but never billed.
 * These represent potential revenue leakage — goods shipped but no invoice raised.
 */
export async function getDeliveriesNotBilled(): Promise<FunctionResult> {
  const cypher = `
    MATCH (dh:DeliveryHeader)
    WHERE NOT (dh)-[:BILLED_IN]->(:BillingItem)
    OPTIONAL MATCH (dh)<-[:PART_OF]-(di:DeliveryItem)
    OPTIONAL MATCH (di)<-[:FULFILLED_BY]-(soi:SalesOrderItem)
    OPTIONAL MATCH (soi)<-[:HAS_ITEM]-(so:SalesOrder)
    OPTIONAL MATCH (c:Customer {id: so.soldToParty})
    RETURN dh.deliveryDocument AS deliveryDocument,
           dh.creationDate AS deliveryDate,
           dh.overallGoodsMovementStatus AS goodsMovementStatus,
           dh.shippingPoint AS shippingPoint,
           so.salesOrder AS salesOrder,
           c.businessPartnerFullName AS customer,
           count(DISTINCT di) AS itemCount
    ORDER BY dh.creationDate DESC
    LIMIT 50
  `;
  const rows = await runQuery(cypher, {});
  return wrapResult(rows, 'getDeliveriesNotBilled');
}

/**
 * Order-to-Payment cycle time per customer.
 * Traces: SalesOrder → SalesOrderItem → DeliveryItem → DeliveryHeader → BillingItem → BillingHeader → Payment
 * Computes days between SalesOrder.creationDate and Payment.clearingDate.
 */
export async function getOrderToPaymentCycleTime(): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)
          -[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
          -[:BILLED_IN]->(bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
          -[:PAID_BY]->(p:Payment)
    WHERE so.creationDate IS NOT NULL AND p.clearingDate IS NOT NULL
    WITH c,
         duration.between(date(so.creationDate), date(p.clearingDate)).days AS cycleDays
    WITH c.businessPartnerFullName AS customer,
         c.id AS customerId,
         round(avg(cycleDays) * 100) / 100.0 AS avgCycleDays,
         min(cycleDays) AS minCycleDays,
         max(cycleDays) AS maxCycleDays,
         count(*) AS transactionCount
    RETURN customer, customerId, avgCycleDays, minCycleDays, maxCycleDays, transactionCount
    ORDER BY avgCycleDays DESC
    LIMIT 30
  `;
  const rows = await runQuery(cypher, {});
  return wrapResult(rows, 'getOrderToPaymentCycleTime');
}

/**
 * Find payments that were received but no journal entry was posted for the billing document.
 * This is a reconciliation gap: money moved but the books don't match.
 */
export async function getPaymentsWithoutJournalEntries(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)-[:PAID_BY]->(p:Payment)
    WHERE NOT (bh)-[:POSTED_AS]->(:JournalEntry)
    OPTIONAL MATCH (c:Customer {id: bh.soldToParty})
    RETURN bh.billingDocument AS billingDocument,
           bh.totalNetAmount AS billingAmount,
           bh.transactionCurrency AS currency,
           p.clearingDate AS paymentDate,
           p.amountInTransactionCurrency AS paymentAmount,
           c.businessPartnerFullName AS customer,
           c.id AS customerId
    ORDER BY toFloat(bh.totalNetAmount) DESC
    LIMIT 50
  `;
  const rows = await runQuery(cypher, {});
  return wrapResult(rows, 'getPaymentsWithoutJournalEntries');
}

export async function getPaymentsCollectedThisMonth(): Promise<FunctionResult> {
  const { startDate, endDate, monthLabel } = monthBoundsUTC(0);

  const cypher = `
    MATCH (p:Payment)
    WHERE p.clearingDate IS NOT NULL
      AND date(p.clearingDate) >= date($startDate)
      AND date(p.clearingDate) < date($endDate)
    WITH
      sum(toFloat(p.amountInTransactionCurrency)) AS totalCollected,
      head(collect(DISTINCT p.transactionCurrency)) AS currency
    RETURN
      $monthLabel AS month,
      round(totalCollected * 100) / 100.0 AS totalCollected,
      currency
    LIMIT 1
  `;

  const rows = await runQuery(cypher, { startDate, endDate, monthLabel });
  return wrapResult(rows, 'getPaymentsCollectedThisMonth');
}

export async function getPaymentsCollectedLastMonth(): Promise<FunctionResult> {
  const { startDate, endDate, monthLabel } = monthBoundsUTC(-1);

  const cypher = `
    MATCH (p:Payment)
    WHERE p.clearingDate IS NOT NULL
      AND date(p.clearingDate) >= date($startDate)
      AND date(p.clearingDate) < date($endDate)
    WITH
      sum(toFloat(p.amountInTransactionCurrency)) AS totalCollected,
      head(collect(DISTINCT p.transactionCurrency)) AS currency
    RETURN
      $monthLabel AS month,
      round(totalCollected * 100) / 100.0 AS totalCollected,
      currency
    LIMIT 1
  `;

  const rows = await runQuery(cypher, { startDate, endDate, monthLabel });
  return wrapResult(rows, 'getPaymentsCollectedLastMonth');
}

export async function getSalesRevenueLastMonth(): Promise<FunctionResult> {
  const { startDate, endDate, monthLabel } = monthBoundsUTC(-1);

  const cypher = `
    MATCH (so:SalesOrder)
    WHERE so.creationDate IS NOT NULL
      AND date(so.creationDate) >= date($startDate)
      AND date(so.creationDate) < date($endDate)
    WITH
      sum(toFloat(so.totalNetAmount)) AS totalSalesRevenue,
      head(collect(DISTINCT so.transactionCurrency)) AS currency
    RETURN
      $monthLabel AS month,
      round(totalSalesRevenue * 100) / 100.0 AS totalSalesRevenue,
      currency
    LIMIT 1
  `;

  const rows = await runQuery(cypher, { startDate, endDate, monthLabel });
  return wrapResult(rows, 'getSalesRevenueLastMonth');
}

export async function getOrdersPlacedByCustomer(customerId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer {id: $customerId})
    OPTIONAL MATCH (c)-[:PLACED]->(so:SalesOrder)
    WITH
      c,
      count(DISTINCT so) AS orderCount,
      collect(DISTINCT so.id) AS orderIds,
      head(collect(DISTINCT so.transactionCurrency)) AS currency
    RETURN
      c.businessPartnerFullName AS customerName,
      c.id AS customerId,
      orderCount,
      orderIds[..50] AS orderIds,
      currency
    LIMIT 1
  `;

  const rows = await runQuery(cypher, { customerId });
  return wrapResult(rows, 'getOrdersPlacedByCustomer');
}

export async function getProductsStoredInPlant(plantId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (pl:Plant {id: $plantId})
    MATCH (pl)<-[:IN_PLANT]-(pp:ProductPlant)<-[:STOCKED_AT]-(p:Product)
    RETURN
      p.product AS productId,
      p.productDescription AS productDescription,
      p.productGroup AS productGroup
    ORDER BY productDescription
    LIMIT 50
  `;

  const rows = await runQuery(cypher, { plantId });
  return wrapResult(rows, 'getProductsStoredInPlant');
}

export async function getCancelledInvoicesSummary(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bc:BillingCancellation)
    OPTIONAL MATCH (bc)-[:CANCELS]->(bh:BillingHeader)
    WITH
      count(DISTINCT bc) AS cancelledDocsCount,
      sum(toFloat(bc.totalNetAmount)) AS totalCancellationAmount,
      head(collect(DISTINCT bc.transactionCurrency)) AS currency,
      collect(DISTINCT bc.billingDocument)[..20] AS sampleCancelledInvoiceDocIds,
      collect(DISTINCT bh.billingDocument)[..20] AS sampleCancelledBillingDocs
    RETURN
      cancelledDocsCount,
      round(totalCancellationAmount * 100) / 100.0 AS totalCancellationAmount,
      currency,
      sampleCancelledInvoiceDocIds,
      sampleCancelledBillingDocs
    LIMIT 1
  `;

  const rows = await runQuery(cypher, {});
  return wrapResult(rows, 'getCancelledInvoicesSummary');
}

export async function getO2CGraphSchemaDesign(): Promise<FunctionResult> {
  return wrapResult(
    [
      {
        nodes: [
          { label: 'Customer', key: 'id', keyProps: ['id', 'businessPartnerFullName', 'businessPartnerIsBlocked'] },
          { label: 'SalesOrder', key: 'id', keyProps: ['id', 'soldToParty', 'creationDate', 'totalNetAmount', 'transactionCurrency'] },
          { label: 'SalesOrderItem', key: 'id', keyProps: ['id', 'salesOrder', 'salesOrderItem', 'material', 'netAmount'] },
          { label: 'DeliveryHeader', key: 'id', keyProps: ['id', 'deliveryDocument', 'creationDate', 'overallGoodsMovementStatus'] },
          { label: 'DeliveryItem', key: 'id', keyProps: ['id', 'deliveryDocument', 'deliveryDocumentItem', 'plant', 'referenceSdDocument', 'referenceSdDocumentItem'] },
          { label: 'BillingHeader', key: 'id', keyProps: ['id', 'billingDocument', 'billingDocumentDate', 'soldToParty', 'totalNetAmount', 'transactionCurrency', 'billingDocumentIsCancelled'] },
          { label: 'BillingItem', key: 'id', keyProps: ['id', 'billingDocument', 'billingDocumentItem', 'referenceSdDocument', 'referenceSdDocumentItem', 'netAmount'] },
          { label: 'Payment', key: 'id', keyProps: ['id', 'accountingDocument', 'clearingDate', 'amountInTransactionCurrency', 'customer'] },
          { label: 'JournalEntry', key: 'id', keyProps: ['id', 'accountingDocument', 'amountInTransactionCurrency', 'profitCenter'] },
          { label: 'Plant', key: 'id', keyProps: ['id', 'plant', 'plantName'] },
          { label: 'Product', key: 'id', keyProps: ['id', 'product', 'productDescription', 'productGroup'] },
          { label: 'ProductPlant', key: 'id', keyProps: ['id', 'product', 'plant', 'profitCenter'] }
        ],
        relationships: [
          { type: 'PLACED', from: 'Customer', to: 'SalesOrder', cardinality: '1 Customer -> many SalesOrder' },
          { type: 'HAS_ITEM', from: 'SalesOrder', to: 'SalesOrderItem', cardinality: '1 SalesOrder -> many SalesOrderItem' },
          { type: 'REFERENCES', from: 'SalesOrderItem', to: 'Product', cardinality: 'many SalesOrderItem -> 1 Product' },
          { type: 'FULFILLED_BY', from: 'SalesOrderItem', to: 'DeliveryItem', cardinality: '1 SalesOrderItem -> 0..many DeliveryItem' },
          { type: 'PART_OF', from: 'DeliveryItem', to: 'DeliveryHeader', cardinality: 'many DeliveryItem -> 1 DeliveryHeader' },
          { type: 'AT_PLANT', from: 'DeliveryItem', to: 'Plant', cardinality: 'many DeliveryItem -> 1 Plant' },
          { type: 'BILLED_IN', from: 'DeliveryHeader', to: 'BillingItem', cardinality: '1 DeliveryHeader -> 0..many BillingItem' },
          { type: 'PART_OF', from: 'BillingItem', to: 'BillingHeader', cardinality: 'many BillingItem -> 1 BillingHeader' },
          { type: 'POSTED_AS', from: 'BillingHeader', to: 'JournalEntry', cardinality: '1 BillingHeader -> 0..many JournalEntry' },
          { type: 'PAID_BY', from: 'BillingHeader', to: 'Payment', cardinality: '1 BillingHeader -> 0..many Payment' },
          { type: 'STOCKED_AT', from: 'Product', to: 'ProductPlant', cardinality: '1 Product -> many ProductPlant' },
          { type: 'IN_PLANT', from: 'ProductPlant', to: 'Plant', cardinality: 'many ProductPlant -> 1 Plant' }
        ],
        edgePropertyNote: 'In this SAP O2C graph, edges (relationships) are structural navigational links and do NOT carry custom properties. All business data lives on the nodes. For example, the FULFILLED_BY edge connecting SalesOrderItem to DeliveryItem has no properties — the join keys (referenceSdDocument, referenceSdDocumentItem) are stored as properties on the DeliveryItem node, not on the edge. This is a common SAP graph modeling pattern: edges encode structure, nodes encode data.',
        edgePropertyExamples: [
          { edge: 'FULFILLED_BY', note: 'No edge properties. Join keys referenceSdDocument and referenceSdDocumentItem are stored on the DeliveryItem node.' },
          { edge: 'BILLED_IN', note: 'No edge properties. Join keys referenceSdDocument and referenceSdDocumentItem are stored on the BillingItem node.' },
          { edge: 'PLACED', note: 'No edge properties. The link is established via SalesOrder.soldToParty = Customer.id.' },
        ],
        nodePropertyExamples: [
          { node: 'Customer', property: 'businessPartnerFullName', example: 'The full name of the customer, e.g. "Cardenas, Parker and Avila". This is a node property — it belongs to the Customer node.' },
          { node: 'BillingHeader', property: 'totalNetAmount', example: 'The billing amount as a string, e.g. "1234.56". This is a node property on BillingHeader, not on any edge.' },
          { node: 'DeliveryItem', property: 'referenceSdDocument', example: 'The sales order that this delivery item fulfills. Although this field is used to JOIN DeliveryItem to SalesOrderItem, it is stored as a property on the DeliveryItem node, not on the FULFILLED_BY edge.' },
        ],
        propertyJoins: [
          { description: 'BillingHeader.soldToParty = Customer.id (direct business join, not necessarily an edge)', fields: ['BillingHeader.soldToParty', 'Customer.id'] },
          { description: 'Payment.accountingDocument = BillingHeader.accountingDocument', fields: ['Payment.accountingDocument', 'BillingHeader.accountingDocument'] }
        ]
      }
    ],
    'getO2CGraphSchemaDesign'
  );
}

/**
 * Describes how the NL-to-graph translation pipeline works.
 * Used for meta-system questions like "How does your system translate NL to Cypher?"
 */
export async function getSystemPipelineDescription(
  mentionedQuery?: string,
  mentionedEntities?: Record<string, string>
): Promise<FunctionResult> {
  // Build a specific Cypher example if a query was mentioned
  let cypherExample = 'MATCH (c:Customer)-[:PLACED]->(so:SalesOrder) WHERE c.id = "310000108" RETURN c.businessPartnerFullName AS customerName, so.salesOrder AS salesOrderNumber, so.creationDate ORDER BY so.creationDate LIMIT 50';
  let cypherExplanation = 'This Cypher query traverses the PLACED edge from Customer to SalesOrder, filters by Customer ID, and returns the order details.';

  if (mentionedQuery && /sales order/i.test(mentionedQuery) && mentionedEntities?.Customer) {
    cypherExample = `MATCH (c:Customer {id: "${mentionedEntities.Customer}"})-[:PLACED]->(so:SalesOrder) RETURN c.businessPartnerFullName AS customerName, so.salesOrder AS salesOrderNumber, so.creationDate AS orderDate, so.totalNetAmount AS orderAmount ORDER BY so.creationDate LIMIT 50`;
    cypherExplanation = `1. MATCH finds the Customer node with id="${mentionedEntities.Customer}". 2. The PLACED edge connects Customer to its SalesOrder nodes. 3. RETURN selects the relevant fields. This is a single-hop traversal (Customer -> SalesOrder), NOT a full O2C lifecycle trace.`;
  }

  return wrapResult(
    [
      {
        pipelineDescription: 'The SAP O2C Graph Intelligence system uses a 6-node pipeline to translate natural language questions into graph database queries.',
        steps: [
          { node: 1, name: 'Context Resolution', description: 'Resolves pronouns and references using conversation history. Example: "Show me that order" becomes "Show me order 740556" if that order was discussed earlier.', llmCalls: 0 },
          { node: 2, name: 'Guardrail + Intent + Complexity', description: 'Classifies the question by intent (LOOKUP, TRAVERSE, AGGREGATE, DETECT, COMPARE) and assigns a complexity tier. Uses keyword matching first (0 LLM calls), falls back to LLM for ambiguous questions.', llmCalls: '0 or 1' },
          { node: 3, name: 'Entity Extraction', description: 'Regex-based extraction of entity IDs (Customer IDs, Sales Order numbers, Billing Document IDs) from the question text.', llmCalls: 0 },
          { node: 4, name: 'Plan Router + Function Selector', description: 'Matches the question against 53 pre-defined query plans using cosine similarity. If a plan matches, its pre-built function is used. Otherwise, falls back to LLM-based function selection.', llmCalls: '0 or 1' },
          { node: 5, name: 'Hybrid Executor', description: 'If a function was selected: executes the pre-built Cypher query (guaranteed correct). If no function matched: uses GraphRAG to retrieve similar examples and schema context, then asks the LLM to generate a Cypher query.', llmCalls: '0 or 1' },
          { node: 6, name: 'Answer Formatter', description: 'Formats the raw query results into a natural language answer with proper currency formatting, entity references, and contract verification.', llmCalls: '0 or 1' },
        ],
        translationExample: {
          userQuestion: mentionedQuery || 'Show me all sales orders for customer 310000108',
          step1_entityExtraction: mentionedEntities ?? { Customer: '310000108' },
          step2_intentClassification: 'LOOKUP (keyword "show" + entity ID detected)',
          step3_functionSelection: 'getCustomer or plan-based Customer->SalesOrder traversal',
          step4_cypherGenerated: cypherExample,
          step5_cypherExplanation: cypherExplanation,
          scopeNote: 'IMPORTANT: The system generates a query scoped to EXACTLY what was asked. "Show me sales orders for customer X" generates a Customer->SalesOrder single-hop query, NOT a full O2C lifecycle trace through deliveries, billing, payments, etc.',
        },
      }
    ],
    'getSystemPipelineDescription'
  );
}

export async function analyzeBillingCancellationAnomaly(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bc:BillingCancellation)
    OPTIONAL MATCH (bc)-[:CANCELS]->(bh:BillingHeader)
    WITH
      count(DISTINCT bc) AS cancellationNodes,
      count(DISTINCT bh) AS headersLinkedByEdge,
      count(DISTINCT CASE WHEN bh IS NULL THEN bc END) AS cancellationWithoutEdgeCount
    MATCH (bh2:BillingHeader)
    WITH
      cancellationNodes,
      headersLinkedByEdge,
      cancellationWithoutEdgeCount,
      count(bh2) AS billingHeadersTotal,
      sum(CASE WHEN bh2.billingDocumentIsCancelled = true OR bh2.billingDocumentIsCancelled = 'true' THEN 1 ELSE 0 END) AS cancelledHeadersFlagged
    RETURN
      cancellationNodes,
      billingHeadersTotal,
      cancelledHeadersFlagged,
      headersLinkedByEdge,
      cancellationWithoutEdgeCount
    LIMIT 1
  `;
  const rows = await runQuery(cypher, {});
  return wrapResult(rows, 'analyzeBillingCancellationAnomaly');
}

export async function getProfitCenterToProductsTrace(): Promise<FunctionResult> {
  const cypher = `
    MATCH (je:JournalEntry)
    WITH je.profitCenter AS profitCenter, count(je) AS journalEntryCount
    WHERE profitCenter IS NOT NULL AND profitCenter <> ''
    ORDER BY journalEntryCount DESC
    LIMIT 1
    WITH profitCenter, journalEntryCount
    MATCH (pp:ProductPlant)
    WHERE pp.profitCenter = profitCenter
    WITH profitCenter, journalEntryCount, count(DISTINCT pp) AS productPlantRows, collect(DISTINCT pp.product)[..20] AS sampleProductIds
    RETURN profitCenter, journalEntryCount, productPlantRows, sampleProductIds
    LIMIT 1
  `;
  const rows = await runQuery(cypher, {});
  return wrapResult(rows, 'getProfitCenterToProductsTrace');
}

