import { runQuery } from '../db.js';
import type { FunctionResult, QueryResult } from '../types/index.js';

function wrapResult(records: QueryResult[], funcName: string): FunctionResult {
  return { records, metadata: { count: records.length, functionName: funcName } };
}

export async function findBrokenFlows(type: string): Promise<FunctionResult> {
  if (type === 'undelivered') {
    const cypher = `
      MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)-[:HAS_SCHEDULE_LINE]->(sl:ScheduleLine)
      WHERE NOT (soi)-[:FULFILLED_BY]->(:DeliveryItem)
      RETURN so.id AS orderId, so.soldToParty AS customer,
             count(soi) AS undeliveredItemCount
      ORDER BY undeliveredItemCount DESC LIMIT 20
    `;
    const records = await runQuery(cypher, {});
    return wrapResult(records, 'findBrokenFlows');
  }

  if (type === 'unbilled') {
    const cypher = `
      MATCH (dh:DeliveryHeader)<-[:PART_OF]-(di:DeliveryItem)
      WHERE NOT (dh)-[:BILLED_IN]->(:BillingItem)
      RETURN dh.id AS deliveryId, dh.creationDate AS createdAt,
             count(di) AS itemCount
      ORDER BY itemCount DESC LIMIT 20
    `;
    const records = await runQuery(cypher, {});
    return wrapResult(records, 'findBrokenFlows');
  }

  // type === 'unpaid'
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE NOT (bh)-[:PAID_BY]->(:Payment)
      AND bh.billingDocumentIsCancelled <> true
    OPTIONAL MATCH (bh)<-[:PART_OF]-(bi:BillingItem)
    RETURN bh.id AS billingDocId, bh.billingDocumentDate AS docDate,
           bh.totalNetAmount AS amount, bh.transactionCurrency AS currency,
           count(bi) AS itemCount
    ORDER BY toFloat(bh.totalNetAmount) DESC LIMIT 20
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'findBrokenFlows');
}

export async function getUnpaidInvoices(limit: number): Promise<FunctionResult> {
  const safeLimit = Math.min(Math.max(1, limit), 50);
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE NOT (bh)-[:PAID_BY]->(:Payment)
      AND bh.billingDocumentIsCancelled <> true
    OPTIONAL MATCH (c:Customer {id: bh.soldToParty})
    RETURN bh.id AS billingDocId, bh.totalNetAmount AS amount,
           bh.transactionCurrency AS currency, bh.billingDocumentDate AS docDate,
           c.businessPartnerFullName AS customerName
    ORDER BY toFloat(bh.totalNetAmount) DESC LIMIT $limit
  `;
  const records = await runQuery(cypher, { limit: safeLimit });
  return wrapResult(records, 'getUnpaidInvoices');
}

export async function getCancelledDocs(limit: number): Promise<FunctionResult> {
  const safeLimit = Math.min(Math.max(1, limit), 50);
  const cypher = `
    MATCH (bc:BillingCancellation)
    OPTIONAL MATCH (bc)-[:CANCELS]->(bh:BillingHeader)
    OPTIONAL MATCH (bh)<-[:PART_OF]-(:BillingItem)<-[:BILLED_IN]-(dh:DeliveryHeader)
    RETURN bc.id AS cancelledDocId, bc.totalNetAmount AS amount,
           bc.billingDocumentDate AS docDate, bc.transactionCurrency AS currency,
           collect(DISTINCT dh.id)[..3] AS relatedDeliveries
    ORDER BY bc.billingDocumentDate DESC LIMIT $limit
  `;
  const records = await runQuery(cypher, { limit: safeLimit });
  return wrapResult(records, 'getCancelledDocs');
}

export async function getCustomerBillingSummary(customerId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.soldToParty = $customerId
    OPTIONAL MATCH (bh)-[:PAID_BY]->(pay:Payment)
    WITH bh,
         CASE WHEN bh.billingDocumentIsCancelled = true OR bh.billingDocumentIsCancelled = 'true' THEN true ELSE false END AS isCancelled,
         CASE WHEN pay IS NOT NULL THEN true ELSE false END AS isPaid,
         toFloat(bh.totalNetAmount) AS amount
    RETURN count(bh) AS totalBillingDocs,
           sum(CASE WHEN NOT isCancelled THEN 1 ELSE 0 END) AS activeDocs,
           sum(CASE WHEN isCancelled THEN 1 ELSE 0 END) AS cancelledDocs,
           sum(CASE WHEN isPaid AND NOT isCancelled THEN 1 ELSE 0 END) AS paidDocs,
           sum(CASE WHEN NOT isPaid AND NOT isCancelled THEN 1 ELSE 0 END) AS unpaidDocs,
           sum(CASE WHEN NOT isPaid AND NOT isCancelled THEN amount ELSE 0 END) AS outstandingAmount,
           sum(CASE WHEN NOT isCancelled THEN amount ELSE 0 END) AS totalActiveAmount,
           collect(DISTINCT bh.transactionCurrency)[0] AS currency
  `;
  const records = await runQuery(cypher, { customerId });
  return wrapResult(records, 'getCustomerBillingSummary');
}

export async function getCancelledAfterPayment(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled = true
    MATCH (pay:Payment)
    WHERE pay.accountingDocument = bh.accountingDocument
      AND pay.clearingDate IS NOT NULL
    WITH bh, pay
    RETURN count(DISTINCT bh) AS cancelledAfterPaymentCount,
           sum(toFloat(bh.totalNetAmount)) AS totalAmount,
           collect(DISTINCT bh.transactionCurrency)[0] AS currency,
           collect(DISTINCT {
             billingDoc: bh.billingDocument,
             amount: bh.totalNetAmount,
             cancelDate: bh.billingDocumentDate,
             paymentDate: pay.clearingDate,
             customer: bh.soldToParty
           })[..10] AS sampleDocs
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getCancelledAfterPayment');
}

export async function getCustomersWithoutBilling(): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)
    WHERE NOT EXISTS {
      MATCH (bh:BillingHeader)
      WHERE bh.soldToParty = c.id
    }
    RETURN c.id AS customerId,
           c.businessPartnerFullName AS customerName,
           c.businessPartnerIsBlocked AS isBlocked
    ORDER BY c.businessPartnerFullName
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getCustomersWithoutBilling');
}

export async function getProductsNeverDelivered(): Promise<FunctionResult> {
  // Step 1: Get all sales orders that have at least one delivery
  const deliveredResult = await runQuery(
    'MATCH (di:DeliveryItem) RETURN collect(DISTINCT di.referenceSdDocument) AS deliveredSOs',
    {}
  );
  const deliveredSOs = (deliveredResult[0] as Record<string, unknown>)?.deliveredSOs ?? [];

  // Step 2: Products whose orders are ALL in undelivered SOs
  const cypher = `
    MATCH (soi:SalesOrderItem)-[:REFERENCES]->(p:Product)
    WITH p, collect(DISTINCT soi.salesOrder) AS orders
    WHERE NONE(so IN orders WHERE so IN $deliveredSOs)
    RETURN p.product AS productId, p.productDescription AS productDescription, orders AS salesOrders
    ORDER BY p.productDescription
    LIMIT 50
  `;
  const records = await runQuery(cypher, { deliveredSOs });
  return wrapResult(records, 'getProductsNeverDelivered');
}

export async function getFullAnomalyReport(): Promise<FunctionResult> {
  const report: QueryResult[] = [];
  async function safeQuery(cypher: string): Promise<QueryResult[]> {
    try { return await runQuery(cypher, {}); }
    catch (e) { console.error('  [AnomalyReport] Query failed:', (e as Error).message?.substring(0, 100)); return []; }
  }

  // Run ALL 6 checks SEQUENTIALLY (Aura free tier can't handle parallel)
  report.push(...await safeQuery(`
    MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)
    WHERE NOT EXISTS { MATCH (soi)-[:FULFILLED_BY]->(:DeliveryItem) }
    WITH so, count(soi) AS items
    RETURN 'ORDERS_NOT_DELIVERED' AS anomalyType, count(so) AS count, sum(items) AS totalItems
  `));
  report.push(...await safeQuery(`
    MATCH (dh:DeliveryHeader)
    WHERE NOT EXISTS { MATCH (dh)-[:BILLED_IN]->(:BillingItem) }
    RETURN 'DELIVERIES_NOT_BILLED' AS anomalyType, count(dh) AS count, collect(dh.deliveryDocument)[..5] AS sampleDocs
  `));
  report.push(...await safeQuery(`
    MATCH (bh:BillingHeader) WHERE bh.billingDocumentIsCancelled = false AND NOT EXISTS { MATCH (bh)-[:PAID_BY]->(:Payment) }
    RETURN 'INVOICES_NOT_PAID' AS anomalyType, count(bh) AS count, sum(toFloat(bh.totalNetAmount)) AS totalValue
  `));
  report.push(...await safeQuery(`
    MATCH (bc:BillingCancellation)-[:CANCELS]->(bh:BillingHeader)-[:PAID_BY]->(p:Payment)
    RETURN 'CANCELLED_AFTER_PAYMENT' AS anomalyType, count(DISTINCT bh) AS count, sum(toFloat(bh.totalNetAmount)) AS totalValue
  `));
  report.push(...await safeQuery(`
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder) WHERE c.businessPartnerIsBlocked = true
    RETURN 'BLOCKED_WITH_ORDERS' AS anomalyType, count(DISTINCT c) AS customerCount, count(DISTINCT so) AS orderCount,
           sum(toFloat(so.totalNetAmount)) AS totalValue, collect(DISTINCT c.businessPartnerFullName) AS customers
  `));
  report.push(...await safeQuery(`
    MATCH (bh:BillingHeader) WHERE bh.billingDocumentIsCancelled = false AND NOT EXISTS { MATCH (bh)-[:POSTED_AS]->(:JournalEntry) }
    RETURN 'FI_POSTING_GAPS' AS anomalyType, count(bh) AS count, sum(toFloat(bh.totalNetAmount)) AS totalValue
  `));

  return wrapResult(report, 'getFullAnomalyReport');
}

// ── Q6 FIX: Delivery fulfillment rate with CORRECT item counts ──
export async function getDeliveryFulfillmentRate(): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)
    WITH c, so, soi
    OPTIONAL MATCH (soi)-[:FULFILLED_BY]->(di:DeliveryItem)
    WITH c,
         count(DISTINCT soi) AS totalItems,
         count(DISTINCT di) AS deliveredItems,
         collect(DISTINCT so.salesOrder) AS orderIds,
         count(DISTINCT so) AS orderCount,
         sum(toFloat(soi.requestedQuantity)) AS totalQuantity
    WITH c, totalItems, deliveredItems, orderIds, orderCount, totalQuantity,
         CASE WHEN totalItems = 0 THEN 0 ELSE round(toFloat(deliveredItems) / toFloat(totalItems) * 10000) / 100.0 END AS fulfillmentRate
    RETURN c.id AS customerId,
           c.businessPartnerFullName AS customerName,
           orderCount,
           orderIds,
           totalItems,
           deliveredItems,
           totalQuantity,
           fulfillmentRate
    ORDER BY fulfillmentRate ASC, customerName
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getDeliveryFulfillmentRate');
}

// ── Q7 FIX: Most expensive billing item ──
export async function getMostExpensiveBillingItem(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
    WITH bi, bh, toFloat(bi.netAmount) AS amount
    ORDER BY amount DESC
    LIMIT 10
    OPTIONAL MATCH (soi:SalesOrderItem {salesOrder: bi.referenceSdDocument, material: bi.material})-[:REFERENCES]->(p:Product)
    OPTIONAL MATCH (bc:BillingCancellation)-[:CANCELS]->(bh)
    OPTIONAL MATCH (cust:Customer {id: bh.soldToParty})
    RETURN bi.billingDocument AS billingDocument,
           bi.billingDocumentItem AS billingDocumentItem,
           bi.netAmount AS netAmount,
           bh.transactionCurrency AS currency,
           p.productDescription AS productDescription,
           p.product AS productId,
           bh.billingDocumentIsCancelled AS isCancelled,
           bc.billingDocument AS cancellingDocument,
           bh.soldToParty AS customerId,
           cust.businessPartnerFullName AS customerName,
           bh.billingDocumentDate AS billingDate
    ORDER BY toFloat(bi.netAmount) DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getMostExpensiveBillingItem');
}

// ── Q8 FIX: Journal entry distribution — NO premature LIMIT ──
export async function getJournalEntryDistribution(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)-[:POSTED_AS]->(je:JournalEntry)
    WITH bh.soldToParty AS customerId, je,
         toFloat(je.amountInTransactionCurrency) AS amount
    WITH customerId,
         count(je) AS totalEntries,
         sum(CASE WHEN amount > 0 THEN 1 ELSE 0 END) AS positiveEntries,
         sum(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS negativeEntries,
         sum(amount) AS netAmount
    MATCH (c:Customer {id: customerId})
    RETURN c.id AS customerId,
           c.businessPartnerFullName AS customerName,
           totalEntries,
           positiveEntries,
           negativeEntries,
           round(netAmount * 100) / 100.0 AS netAmount
    ORDER BY totalEntries DESC
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getJournalEntryDistribution');
}

// ── Q9 FIX: Payment clearing time — proper accountingDocument join ──
export async function getPaymentClearingTime(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled <> true
    MATCH (pay:Payment {accountingDocument: bh.accountingDocument})
    WHERE bh.billingDocumentDate IS NOT NULL AND pay.clearingDate IS NOT NULL
    WITH bh, pay,
         date(bh.billingDocumentDate) AS billDate,
         date(pay.clearingDate) AS clearDate
    WITH bh.billingDocument AS billingDocument,
         bh.billingDocumentDate AS billingDate,
         pay.clearingDate AS clearingDate,
         bh.soldToParty AS customerId,
         bh.totalNetAmount AS amount,
         bh.transactionCurrency AS currency,
         duration.between(billDate, clearDate).days AS daysToClear
    RETURN billingDocument, billingDate, clearingDate, customerId,
           amount, currency, daysToClear
    ORDER BY daysToClear DESC
    LIMIT 100
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getPaymentClearingTime');
}

// ── Q10 FIX: Payment terms split — reads customerPaymentTerms ──
export async function getPaymentTermsSplit(): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
    WITH c, so.customerPaymentTerms AS paymentTerm, count(so) AS orderCount,
         collect(so.salesOrder) AS orderIds
    RETURN c.id AS customerId,
           c.businessPartnerFullName AS customerName,
           paymentTerm,
           orderCount,
           orderIds
    ORDER BY paymentTerm, customerName
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getPaymentTermsSplit');
}

// ── Q4 FIX: Billing document type breakdown ──
export async function getBillingDocTypeBreakdown(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WITH bh.billingDocumentType AS docType,
         count(bh) AS totalDocs,
         sum(CASE WHEN bh.billingDocumentIsCancelled = true THEN 1 ELSE 0 END) AS cancelledCount,
         sum(toFloat(bh.totalNetAmount)) AS totalNetAmount,
         bh.transactionCurrency AS currency
    RETURN docType, totalDocs, cancelledCount,
           round(totalNetAmount * 100) / 100.0 AS totalNetAmount,
           currency
    ORDER BY totalDocs DESC
    LIMIT 20
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getBillingDocTypeBreakdown');
}

// ── Q7 FIX: Plant revenue ranking ──
// Path: DeliveryItem → AT_PLANT → Plant, and DeliveryItem ← PART_OF ← DeliveryHeader
// Then DeliveryHeader → BILLED_IN → BillingItem → PART_OF → BillingHeader (for revenue)
export async function getPlantRevenueRanking(): Promise<FunctionResult> {
  const cypher = `
    MATCH (di:DeliveryItem)-[:AT_PLANT]->(pl:Plant)
    MATCH (di)-[:PART_OF]->(dh:DeliveryHeader)
    MATCH (dh)-[:BILLED_IN]->(bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
    // Tolerate both boolean and string representations from the dataset.
    WHERE bh.billingDocumentIsCancelled = false
      OR bh.billingDocumentIsCancelled = 'false'
      OR bh.billingDocumentIsCancelled IS NULL
      // Align billing item to the specific delivery item to avoid attributing
      // header-level billing revenue across the wrong plant.
      AND bi.referenceSdDocument = dh.id
      AND toInteger(bi.referenceSdDocumentItem) = toInteger(di.deliveryDocumentItem)
    // Dedup: count each billing item once per plant.
    WITH DISTINCT
      pl.plant AS plantId,
      pl.plantName AS plantName,
      bi.id AS billingItemId,
      toFloat(bi.netAmount) AS netAmount,
      bh.id AS billingDocId,
      bh.transactionCurrency AS currency
    WITH
      plantId,
      plantName,
      sum(netAmount) AS totalBilledRevenue,
      count(DISTINCT billingDocId) AS billingDocCount,
      head(collect(DISTINCT currency)) AS currency
    CALL {
      WITH plantId
      MATCH (di:DeliveryItem)-[:AT_PLANT]->(pl:Plant {id: plantId})
      RETURN count(DISTINCT di) AS deliveryItemCount
    }
    RETURN plantId, plantName,
           round(totalBilledRevenue * 100) / 100.0 AS totalBilledRevenue,
           billingDocCount, deliveryItemCount, currency
    ORDER BY totalBilledRevenue DESC
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getPlantRevenueRanking');
}

// ── Q9 FIX: Active (non-cancelled) billing docs that have NOT been paid ──
export async function getUnpaidActiveBillingDocs(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled = false
      AND NOT EXISTS { MATCH (bh)-[:PAID_BY]->(:Payment) }
    WITH bh
    OPTIONAL MATCH (c:Customer {id: bh.soldToParty})
    WITH c.id AS customerId,
         c.businessPartnerFullName AS customerName,
         count(bh) AS unpaidDocCount,
         sum(toFloat(bh.totalNetAmount)) AS outstandingAmount,
         collect(bh.billingDocument) AS docIds,
         bh.transactionCurrency AS currency
    RETURN customerId, customerName, unpaidDocCount, 
           round(outstandingAmount * 100) / 100.0 AS outstandingAmount,
           currency, docIds
    ORDER BY outstandingAmount DESC
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getUnpaidActiveBillingDocs');
}
