import { runQuery } from '../db.js';
import type { FunctionResult, QueryResult } from '../types/index.js';

function wrapResult(records: QueryResult[], funcName: string): FunctionResult {
  return { records, metadata: { count: records.length, functionName: funcName } };
}

export async function getTopProducts(
  metric: string,
  limit: number
): Promise<FunctionResult> {
  const safeLimit = Math.min(Math.max(1, limit), 50);

  if (metric === 'billing') {
    const cypher = `
      MATCH (bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
      WHERE bh.billingDocumentIsCancelled = false
      MATCH (soi:SalesOrderItem)
      WHERE soi.salesOrder = bi.referenceSdDocument
      MATCH (soi)-[:REFERENCES]->(p:Product)
      RETURN p.id AS productId, p.productDescription AS name,
             count(DISTINCT bh) AS billingDocCount
      ORDER BY billingDocCount DESC LIMIT $limit
    `;
    const records = await runQuery(cypher, { limit: safeLimit });
    return wrapResult(records, 'getTopProducts');
  }

  // metric === 'delivery'
  const cypher = `
    MATCH (di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
    MATCH (soi:SalesOrderItem)-[:FULFILLED_BY]->(di)
    MATCH (soi)-[:REFERENCES]->(p:Product)
    WITH p.id AS productId, p.productDescription AS name, count(DISTINCT di) AS deliveryItemCount
    RETURN productId, name, deliveryItemCount
    ORDER BY deliveryItemCount DESC
    LIMIT $limit
  `;
  const records = await runQuery(cypher, { limit: safeLimit });
  return wrapResult(records, 'getTopProducts');
}

export async function getTopCustomers(
  metric: string,
  limit: number
): Promise<FunctionResult> {
  const safeLimit = Math.min(Math.max(1, limit), 50);

  if (metric === 'amount') {
    const cypher = `
      MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
      RETURN c.id AS customerId, c.businessPartnerFullName AS name,
             sum(toFloat(so.totalNetAmount)) AS totalAmount,
             head(collect(so.transactionCurrency)) AS currency
      ORDER BY totalAmount DESC LIMIT $limit
    `;
    const records = await runQuery(cypher, { limit: safeLimit });
    return wrapResult(records, 'getTopCustomers');
  }

  // metric === 'orders'
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
    RETURN c.id AS customerId, c.businessPartnerFullName AS name,
           count(so) AS orderCount
    ORDER BY orderCount DESC LIMIT $limit
  `;
  const records = await runQuery(cypher, { limit: safeLimit });
  return wrapResult(records, 'getTopCustomers');
}

export async function getOrdersByOrg(orgId: string | null): Promise<FunctionResult> {
  if (orgId) {
    const cypher = `
      MATCH (so:SalesOrder {salesOrganization: $orgId})
      OPTIONAL MATCH (so)<-[:PLACED]-(c:Customer)
      RETURN so.salesOrganization AS org, count(so) AS orderCount,
             collect(DISTINCT c.businessPartnerFullName)[..5] AS sampleCustomers
    `;
    const records = await runQuery(cypher, { orgId });
    return wrapResult(records, 'getOrdersByOrg');
  }

  const cypher = `
    MATCH (so:SalesOrder)
    RETURN so.salesOrganization AS org, count(so) AS orderCount
    ORDER BY orderCount DESC
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getOrdersByOrg');
}

export async function getRevenueConcentration(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled = false
    WITH bh.soldToParty AS customerId, toFloat(bh.totalNetAmount) AS amount, bh.transactionCurrency AS curr
    WITH customerId, sum(amount) AS customerRevenue, head(collect(curr)) AS currency
    WITH collect({customerId: customerId, revenue: customerRevenue, currency: currency}) AS customers,
         sum(customerRevenue) AS totalRevenue
    UNWIND customers AS c
    OPTIONAL MATCH (cust:Customer {id: c.customerId})
    RETURN c.customerId AS customerId,
           cust.businessPartnerFullName AS customerName,
           c.revenue AS customerRevenue,
           totalRevenue,
           round(c.revenue / totalRevenue * 10000) / 100.0 AS percentageShare,
           c.currency AS currency
    ORDER BY c.revenue DESC
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getRevenueConcentration');
}

// Active (non-cancelled) billing summary across ALL billing documents.
export async function getActiveBillingTotals(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WITH bh,
         CASE
           WHEN bh.billingDocumentIsCancelled = true OR bh.billingDocumentIsCancelled = 'true' OR bh.billingDocumentIsCancelled = 1 THEN true
           ELSE false
         END AS isCancelled,
         toFloat(bh.totalNetAmount) AS amount
    WITH
      count(bh) AS totalDocs,
      sum(CASE WHEN NOT isCancelled THEN 1 ELSE 0 END) AS activeDocs,
      sum(CASE WHEN NOT isCancelled THEN amount ELSE 0 END) AS activeTotalNetAmount,
      head(collect(bh.transactionCurrency)) AS currency
    RETURN
      activeDocs,
      totalDocs,
      CASE
        WHEN totalDocs = 0 THEN 0
        ELSE round(toFloat(activeDocs) / toFloat(totalDocs) * 10000) / 100.0
      END AS activePercentage,
      round(activeTotalNetAmount * 100) / 100.0 AS activeTotalNetAmount,
      currency
    LIMIT 1
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getActiveBillingTotals');
}

// Top month by active billing revenue with % of all active revenue.
export async function getTopActiveBillingMonthRevenue(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentDate IS NOT NULL
    WITH bh,
         CASE
           WHEN bh.billingDocumentIsCancelled = true OR bh.billingDocumentIsCancelled = 'true' OR bh.billingDocumentIsCancelled = 1 THEN true
           ELSE false
         END AS isCancelled,
         substring(bh.billingDocumentDate, 0, 7) AS month,
         toFloat(bh.totalNetAmount) AS amount,
         bh.transactionCurrency AS currency
    WHERE NOT isCancelled
    WITH month, sum(amount) AS monthRevenue, head(collect(currency)) AS currency
    ORDER BY monthRevenue DESC
    LIMIT 1
    WITH month, monthRevenue, currency

    // Compute total active revenue to get the % share (second aggregation, no window functions).
    MATCH (bh2:BillingHeader)
    WHERE bh2.billingDocumentDate IS NOT NULL
    WITH month, monthRevenue,
         currency,
         CASE
           WHEN bh2.billingDocumentIsCancelled = true OR bh2.billingDocumentIsCancelled = 'true' OR bh2.billingDocumentIsCancelled = 1 THEN true
           ELSE false
         END AS isCancelled2,
         toFloat(bh2.totalNetAmount) AS amount2,
         bh2.transactionCurrency AS currency2
    WHERE NOT isCancelled2
    WITH
      month,
      monthRevenue,
      sum(amount2) AS totalRevenue,
      head(collect(DISTINCT currency2)) AS totalCurrency
    RETURN
      month,
      round(monthRevenue * 100) / 100.0 AS activeRevenueAmount,
      CASE
        WHEN totalRevenue = 0 THEN 0
        ELSE round((monthRevenue / totalRevenue) * 10000) / 100.0
      END AS activeRevenuePercentage,
      round(totalRevenue * 100) / 100.0 AS activeRevenueTotal,
      totalCurrency AS currency
    LIMIT 1
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getTopActiveBillingMonthRevenue');
}

// Now that FULFILLED_BY relationships exist, use simple relationship traversal
export async function getTopDeliveriesByProductCount(limit: number): Promise<FunctionResult> {
  const safeLimit = Math.min(Math.max(1, limit), 50);
  const cypher = `
    MATCH (soi:SalesOrderItem)-[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
    MATCH (soi)-[:REFERENCES]->(p:Product)
    WITH dh.deliveryDocument AS deliveryDocument,
         collect(DISTINCT p.product) AS productIds,
         collect(DISTINCT p.productDescription) AS productNames
    RETURN deliveryDocument,
           size(productIds) AS distinctProductCount,
           productNames[..5] AS sampleProducts
    ORDER BY distinctProductCount DESC
    LIMIT $limit
  `;
  const records = await runQuery(cypher, { limit: safeLimit });
  return wrapResult(records, 'getTopDeliveriesByProductCount');
}

// ── M2 FIX: SO line item statistics (total, avg, min, max per order) ──────────
export async function getSoLineItemStats(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)
    WITH so, count(soi) AS itemsPerOrder
    RETURN
      sum(itemsPerOrder) AS totalLineItems,
      count(so) AS totalOrders,
      round(avg(itemsPerOrder) * 100) / 100.0 AS avgItemsPerOrder,
      min(itemsPerOrder) AS minItemsPerOrder,
      max(itemsPerOrder) AS maxItemsPerOrder
    LIMIT 1
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getSoLineItemStats');
}

// ── M1 FIX: All customers ranked by order count (no customerId needed) ────────
export async function getAllCustomersWithOrderCounts(limit: number): Promise<FunctionResult> {
  const safeLimit = Math.floor(Math.min(Math.max(1, limit), 500));
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
    RETURN
      c.id AS customerId,
      c.businessPartnerFullName AS customerName,
      count(so) AS orderCount
    ORDER BY orderCount DESC
    LIMIT $limit
  `;
  const records = await runQuery(cypher, { limit: safeLimit });
  return wrapResult(records, 'getAllCustomersWithOrderCounts');
}

// ── M5 FIX: Material group breakdown from SalesOrderItem ──────────────────────
export async function getMaterialGroupsAnalysis(): Promise<FunctionResult> {
  const cypher = `
    MATCH (soi:SalesOrderItem)
    WHERE soi.materialGroup IS NOT NULL
    RETURN
      soi.materialGroup AS materialGroup,
      count(soi) AS lineItemCount,
      round(sum(toFloat(soi.requestedQuantity)) * 100) / 100.0 AS totalQuantity,
      round(sum(toFloat(soi.netAmount)) * 100) / 100.0 AS totalNetAmount
    ORDER BY lineItemCount DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getMaterialGroupsAnalysis');
}

// ── M4 FIX: Unique materials ordered vs billed (set comparison) ───────────────
// BillingItem has NO relationship to Product — uses bi.material string property.
export async function getUniqueMaterialsOrderedVsBilled(): Promise<FunctionResult> {
  const cypher = `
    MATCH (soi:SalesOrderItem)-[:REFERENCES]->(p:Product)
    WITH collect(DISTINCT p.id) AS orderedMaterials
    MATCH (bi:BillingItem)
    WHERE bi.material IS NOT NULL
    WITH orderedMaterials, collect(DISTINCT bi.material) AS billedMaterials
    WITH
      orderedMaterials,
      billedMaterials,
      [m IN orderedMaterials WHERE NOT m IN billedMaterials] AS neverBilled
    RETURN
      size(orderedMaterials) AS uniqueMaterialsOrdered,
      size(billedMaterials) AS uniqueMaterialsBilled,
      size(neverBilled) AS materialsNeverBilled,
      neverBilled[..20] AS neverBilledSample
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getUniqueMaterialsOrderedVsBilled');
}

// ── H1 FIX: Per-customer delivery completion rate + undelivered order value ───
export async function getDeliveryCompletionPerCustomer(): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
    WITH c.id AS customerId, c.businessPartnerFullName AS customerName,
         count(so) AS totalOrders,
         sum(CASE WHEN so.overallDeliveryStatus = 'C' THEN 1 ELSE 0 END) AS fullyDelivered,
         sum(CASE WHEN so.overallDeliveryStatus <> 'C' THEN toFloat(so.totalNetAmount) ELSE 0 END) AS undeliveredOrderValue,
         head(collect(so.transactionCurrency)) AS currency
    RETURN customerId, customerName, totalOrders, fullyDelivered,
           CASE WHEN totalOrders = 0 THEN 0
                ELSE round(toFloat(fullyDelivered) / toFloat(totalOrders) * 10000) / 100.0
           END AS deliveryCompletionPct,
           round(undeliveredOrderValue * 100) / 100.0 AS undeliveredOrderValue,
           currency
    ORDER BY deliveryCompletionPct ASC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getDeliveryCompletionPerCustomer');
}

// ── H2 FIX: Top materials by billed quantity (ALL billing docs, not just active) ─
export async function getTopMaterialsByBilledQuantity(limit: number): Promise<FunctionResult> {
  const safeLimit = Math.floor(Math.min(Math.max(1, limit), 50));
  const cypher = `
    MATCH (bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
    WHERE bi.material IS NOT NULL
    WITH bi.material AS materialId,
         sum(toFloat(bi.billingQuantity)) AS totalBilledQty,
         sum(toFloat(bi.netAmount)) AS totalBilledNetAmount,
         head(collect(bh.transactionCurrency)) AS currency
    OPTIONAL MATCH (p:Product {id: materialId})
    RETURN materialId,
           coalesce(p.productDescription, 'N/A') AS productName,
           round(totalBilledQty * 100) / 100.0 AS totalBilledQuantity,
           round(totalBilledNetAmount * 100) / 100.0 AS totalBilledNetAmount,
           currency
    ORDER BY totalBilledQty DESC
    LIMIT $limit
  `;
  const records = await runQuery(cypher, { limit: safeLimit });
  return wrapResult(records, 'getTopMaterialsByBilledQuantity');
}

// ── H4 FIX: Sales order with most line items ──────────────────────────────────
export async function getSalesOrderWithMostLineItems(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)
    WITH so, count(soi) AS itemCount,
         sum(toFloat(soi.netAmount)) AS totalValue
    ORDER BY itemCount DESC
    LIMIT 1
    OPTIONAL MATCH (c:Customer {id: so.soldToParty})
    RETURN so.salesOrder AS salesOrder,
           itemCount,
           round(totalValue * 100) / 100.0 AS totalValue,
           so.transactionCurrency AS currency,
           so.overallDeliveryStatus AS deliveryStatus,
           c.businessPartnerFullName AS customerName,
           c.id AS customerId
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getSalesOrderWithMostLineItems');
}

// ── H3 FIX: Payment collection rate ───────────────────────────────────────────
// A billing doc is "collected" when it has a Payment with a non-empty clearingDate.
// Uses BillingHeader.totalNetAmount (not Payment.amountInTransactionCurrency)
// to avoid SAP double-entry accounting sign issues.
export async function getPaymentCollectionRate(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled = false
    OPTIONAL MATCH (bh)-[:PAID_BY]->(p:Payment)
    WHERE p.clearingDate IS NOT NULL AND p.clearingDate <> ''
    WITH bh, count(p) AS clearedPaymentCount
    WITH sum(toFloat(bh.totalNetAmount)) AS totalActiveBilled,
         sum(CASE WHEN clearedPaymentCount > 0 THEN toFloat(bh.totalNetAmount) ELSE 0 END) AS totalCollected,
         head(collect(DISTINCT bh.transactionCurrency)) AS currency
    RETURN round(totalActiveBilled * 100) / 100.0 AS totalActiveBilled,
           round(totalCollected * 100) / 100.0 AS totalCollected,
           round((totalActiveBilled - totalCollected) * 100) / 100.0 AS outstanding,
           round(totalCollected / totalActiveBilled * 10000) / 100.0 AS collectionPct,
           currency
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getPaymentCollectionRate');
}

// ── getShippingPointBreakdown ─────────────────────────────────────────────────
// Counts how many delivery documents each shipping point handled.
export async function getShippingPointBreakdown(): Promise<FunctionResult> {
  const cypher = `
    MATCH (dh:DeliveryHeader)
    WHERE dh.shippingPoint IS NOT NULL
    WITH dh.shippingPoint AS shippingPoint, count(DISTINCT dh) AS deliveryCount
    RETURN shippingPoint, deliveryCount
    ORDER BY deliveryCount DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getShippingPointBreakdown');
}

// ── getSalesOrderValueByChannel ───────────────────────────────────────────────
// Per-distribution-channel stats: avg, min, max sales order value.
export async function getSalesOrderValueByChannel(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder)
    WHERE so.totalNetAmount IS NOT NULL AND so.distributionChannel IS NOT NULL
    WITH so.distributionChannel AS channel, toFloat(so.totalNetAmount) AS val
    WITH channel,
         count(val)                       AS orderCount,
         round(min(val)*100)/100.0        AS minValue,
         round(max(val)*100)/100.0        AS maxValue,
         round(avg(val)*100)/100.0        AS avgValue,
         round(sum(val)*100)/100.0        AS totalValue
    RETURN channel, orderCount, minValue, maxValue, avgValue, totalValue
    ORDER BY totalValue DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getSalesOrderValueByChannel');
}

// ── getBillingDocsByCreationDate ──────────────────────────────────────────────
// Groups billing documents by creation date: total count, cancelled count,
// active count, and total net amount per date.
export async function getBillingDocsByCreationDate(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.creationDate IS NOT NULL
    WITH bh.creationDate AS creationDate,
         count(bh)                                                            AS totalDocs,
         sum(CASE WHEN bh.billingDocumentIsCancelled = true  THEN 1 ELSE 0 END) AS cancelledDocs,
         sum(CASE WHEN bh.billingDocumentIsCancelled = false OR bh.billingDocumentIsCancelled IS NULL THEN 1 ELSE 0 END) AS activeDocs,
         round(sum(CASE WHEN bh.billingDocumentIsCancelled = false OR bh.billingDocumentIsCancelled IS NULL
                        THEN toFloat(bh.totalNetAmount) ELSE 0 END)*100)/100.0 AS activeNetAmount,
         head(collect(DISTINCT bh.transactionCurrency)) AS currency
    RETURN creationDate, totalDocs, cancelledDocs, activeDocs, activeNetAmount, currency
    ORDER BY creationDate ASC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getBillingDocsByCreationDate');
}

