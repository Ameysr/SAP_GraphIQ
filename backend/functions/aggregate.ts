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
    RETURN di.referenceSdDocument AS refSO, di.referenceSdDocumentItem AS refItem,
           dh.deliveryDocument AS dd
    LIMIT 500
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
