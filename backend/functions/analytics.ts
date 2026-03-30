// ── ANALYTICS FUNCTIONS ──────────────────────────────────────────────────────
// Pre-built Cypher queries for complex analytics that previously had null
// functionName in question_plans.json. Each function wraps an exact Cypher
// query from the curated queryLibrary — no LLM generation needed.

import { runQuery } from '../db.js';
import type { FunctionResult, QueryResult } from '../types/index.js';

function wrapResult(records: QueryResult[], funcName: string): FunctionResult {
  return { records, metadata: { count: records.length, functionName: funcName } };
}

// ── O2C HEALTH SUMMARY ──────────────────────────────────────────────────────
export async function getO2CHealthSummary(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder) WITH count(so) AS totalOrders
    MATCH (dh:DeliveryHeader) WITH totalOrders, count(dh) AS totalDeliveries
    MATCH (bh:BillingHeader) WHERE bh.billingDocumentIsCancelled = false
    WITH totalOrders, totalDeliveries, count(bh) AS totalInvoices,
         sum(toFloat(bh.totalNetAmount)) AS totalBilled
    MATCH (pay:Payment)
    WITH totalOrders, totalDeliveries, totalInvoices,
         round(totalBilled*100)/100.0 AS totalBilled,
         count(pay) AS totalPayments,
         round(sum(toFloat(pay.amountInTransactionCurrency))*100)/100.0 AS totalCollected
    RETURN totalOrders, totalDeliveries, totalInvoices, totalBilled, totalPayments, totalCollected
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getO2CHealthSummary');
}

// ── AR AGING BUCKETS ──────────────────────────────────────────────────────────
export async function getARAgingBuckets(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled = false
    AND NOT (bh)-[:PAID_BY]->(:Payment)
    AND bh.billingDocumentDate IS NOT NULL
    WITH bh,
         date() - date(bh.billingDocumentDate) AS age,
         toFloat(bh.totalNetAmount) AS amount
    WITH bh.soldToParty AS cid,
         sum(CASE WHEN age.days <= 30 THEN amount ELSE 0 END) AS bucket0_30,
         sum(CASE WHEN age.days > 30 AND age.days <= 60 THEN amount ELSE 0 END) AS bucket31_60,
         sum(CASE WHEN age.days > 60 AND age.days <= 90 THEN amount ELSE 0 END) AS bucket61_90,
         sum(CASE WHEN age.days > 90 THEN amount ELSE 0 END) AS bucket90plus
    MATCH (c:Customer {id: cid})
    RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
           round(bucket0_30*100)/100.0 AS aging_0_30,
           round(bucket31_60*100)/100.0 AS aging_31_60,
           round(bucket61_90*100)/100.0 AS aging_61_90,
           round(bucket90plus*100)/100.0 AS aging_90plus
    ORDER BY aging_90plus DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getARAgingBuckets');
}

// ── DSO PER CUSTOMER ──────────────────────────────────────────────────────────
export async function getDSOPerCustomer(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)-[:PAID_BY]->(pay:Payment)
    WHERE bh.billingDocumentIsCancelled = false
    AND bh.billingDocumentDate IS NOT NULL
    AND pay.clearingDate IS NOT NULL
    WITH bh.soldToParty AS cid,
         avg(duration.between(date(bh.billingDocumentDate), date(pay.clearingDate)).days) AS avgDSO,
         count(bh) AS paidInvoices
    MATCH (c:Customer {id: cid})
    RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
           round(avgDSO*10)/10.0 AS avgDSO_days, paidInvoices
    ORDER BY avgDSO DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getDSOPerCustomer');
}

// ── CREDIT EXPOSURE ──────────────────────────────────────────────────────────
export async function getCreditExposure(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled = false
    AND NOT (bh)-[:PAID_BY]->(:Payment)
    WITH bh.soldToParty AS cid, sum(toFloat(bh.totalNetAmount)) AS openAmount, count(bh) AS unpaidDocs
    MATCH (c:Customer {id: cid})
    RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
           round(openAmount*100)/100.0 AS totalExposure, unpaidDocs
    ORDER BY totalExposure DESC LIMIT 20
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getCreditExposure');
}

// ── CANCELLATION RATE BY CUSTOMER ────────────────────────────────────────────
export async function getCancellationRateByCustomer(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WITH bh.soldToParty AS cid, count(bh) AS totalDocs,
         sum(CASE WHEN bh.billingDocumentIsCancelled = true THEN 1 ELSE 0 END) AS cancelledDocs
    MATCH (c:Customer {id: cid})
    WITH c, totalDocs, cancelledDocs,
         round(toFloat(cancelledDocs)/toFloat(totalDocs)*10000)/100.0 AS cancellationRate
    RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
           totalDocs, cancelledDocs, cancellationRate
    ORDER BY cancellationRate DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getCancellationRateByCustomer');
}

// ── CURRENCY ANALYSIS ────────────────────────────────────────────────────────
export async function getCurrencyAnalysis(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled = false
    RETURN bh.transactionCurrency AS currency,
           count(bh) AS documentCount,
           round(sum(toFloat(bh.totalNetAmount))*100)/100.0 AS totalAmount
    ORDER BY documentCount DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getCurrencyAnalysis');
}

// ── BLOCKED CUSTOMERS WITH ORDERS ────────────────────────────────────────────
export async function getBlockedCustomersWithOrders(): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
    WHERE c.businessPartnerIsBlocked = true
    RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
           count(so) AS orderCount,
           sum(toFloat(so.totalNetAmount)) AS totalValue
    ORDER BY totalValue DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getBlockedCustomersWithOrders');
}

// ── CUSTOMER ORDER RECENCY ──────────────────────────────────────────────────
export async function getCustomerOrderRecency(): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)
    OPTIONAL MATCH (c)-[:PLACED]->(so:SalesOrder)
    WITH c, collect(so.creationDate) AS orderDates
    WITH c, orderDates,
         CASE WHEN size(orderDates) = 0 THEN null
              ELSE reduce(latest = orderDates[0], d IN orderDates | CASE WHEN d > latest THEN d ELSE latest END)
         END AS lastOrderDate
    WHERE lastOrderDate IS NULL OR lastOrderDate < toString(date() - duration('P180D'))
    RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
           lastOrderDate,
           CASE WHEN lastOrderDate IS NOT NULL
                THEN duration.between(date(lastOrderDate), date()).days
                ELSE null END AS daysSinceLastOrder
    ORDER BY daysSinceLastOrder DESC
    LIMIT 50
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getCustomerOrderRecency');
}

// ── DELIVERY LEAD TIME ──────────────────────────────────────────────────────
export async function getDeliveryLeadTime(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)-[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
    WHERE so.creationDate IS NOT NULL AND dh.creationDate IS NOT NULL
    WITH so.soldToParty AS cid,
         avg(duration.between(date(so.creationDate), date(dh.creationDate)).days) AS avgLeadDays,
         count(DISTINCT dh) AS deliveries
    MATCH (c:Customer {id: cid})
    RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
           round(avgLeadDays*10)/10.0 AS avgLeadDays, deliveries
    ORDER BY avgLeadDays DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getDeliveryLeadTime');
}

// ── OVERDUE DELIVERIES ──────────────────────────────────────────────────────
export async function getOverdueDeliveries(): Promise<FunctionResult> {
  const cypher = `
    MATCH (soi:SalesOrderItem)-[:HAS_SCHEDULE_LINE]->(sl:ScheduleLine)
    WHERE sl.confirmedDeliveryDate IS NOT NULL
    AND date(sl.confirmedDeliveryDate) < date()
    AND NOT EXISTS { MATCH (soi)-[:FULFILLED_BY]->(:DeliveryItem) }
    OPTIONAL MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi)
    OPTIONAL MATCH (c:Customer {id: so.soldToParty})
    RETURN so.salesOrder AS salesOrder, soi.salesOrderItem AS salesOrderItem,
           sl.confirmedDeliveryDate AS confirmedDate,
           duration.between(date(sl.confirmedDeliveryDate), date()).days AS daysOverdue,
           c.businessPartnerFullName AS customer
    ORDER BY daysOverdue DESC LIMIT 20
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getOverdueDeliveries');
}

// ── HIGH VALUE ORDERS ────────────────────────────────────────────────────────
export async function getHighValueOrders(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder)
    WHERE so.totalNetAmount IS NOT NULL
    WITH avg(toFloat(so.totalNetAmount)) AS avgVal
    MATCH (so2:SalesOrder)
    WHERE toFloat(so2.totalNetAmount) > avgVal * 3
    OPTIONAL MATCH (c:Customer {id: so2.soldToParty})
    RETURN so2.salesOrder AS orderId, so2.soldToParty AS customerId,
           c.businessPartnerFullName AS customerName,
           toFloat(so2.totalNetAmount) AS orderValue,
           round(toFloat(so2.totalNetAmount)/avgVal*100)/100.0 AS timesAvg,
           so2.overallDeliveryStatus AS deliveryStatus
    ORDER BY orderValue DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getHighValueOrders');
}

// ── DEBIT CREDIT TOTALS ──────────────────────────────────────────────────────
export async function getDebitCreditTotals(): Promise<FunctionResult> {
  const cypher = `
    MATCH (je:JournalEntry)
    WITH toFloat(je.amountInTransactionCurrency) AS amount
    RETURN sum(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS totalDebits,
           sum(CASE WHEN amount < 0 THEN abs(amount) ELSE 0 END) AS totalCredits,
           round(sum(amount)*100)/100.0 AS netBalance,
           count(*) AS totalEntries
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getDebitCreditTotals');
}

// ── FI POSTING GAPS ──────────────────────────────────────────────────────────
export async function getFIPostingGaps(): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader)
    WHERE bh.billingDocumentIsCancelled = false
    AND NOT EXISTS { MATCH (bh)-[:POSTED_AS]->(:JournalEntry) }
    RETURN bh.billingDocument AS billingDocument, bh.totalNetAmount AS totalNetAmount,
           bh.transactionCurrency AS currency, bh.soldToParty AS customerId
    ORDER BY toFloat(bh.totalNetAmount) DESC LIMIT 20
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getFIPostingGaps');
}

// ── SINGLE CUSTOMER PRODUCTS ────────────────────────────────────────────────
export async function getSingleCustomerProducts(): Promise<FunctionResult> {
  const cypher = `
    MATCH (soi:SalesOrderItem)-[:REFERENCES]->(p:Product)
    OPTIONAL MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi)
    WITH p, collect(DISTINCT so.soldToParty) AS customers
    WHERE size(customers) = 1
    RETURN p.product AS productId, p.productDescription AS product,
           customers[0] AS soloCustomerId
    ORDER BY p.productDescription
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getSingleCustomerProducts');
}

// ── CROSS-DOMAIN CUSTOMER SUMMARY ───────────────────────────────────────────
export async function getCrossDomainSummary(): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
    WITH c, count(DISTINCT so) AS orders
    OPTIONAL MATCH (c)-[:PLACED]->(:SalesOrder)-[:HAS_ITEM]->(:SalesOrderItem)-[:FULFILLED_BY]->(di:DeliveryItem)
    WITH c, orders, count(DISTINCT di) AS deliveries
    OPTIONAL MATCH (bh:BillingHeader) WHERE bh.soldToParty = c.id AND bh.billingDocumentIsCancelled = false
    WITH c, orders, deliveries, sum(toFloat(bh.totalNetAmount)) AS billingTotal
    RETURN c.businessPartnerFullName AS customer, orders, deliveries,
           round(billingTotal * 100) / 100.0 AS billingTotal
    ORDER BY billingTotal DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getCrossDomainSummary');
}

// ── ORDER VALUE DISTRIBUTION ────────────────────────────────────────────────
export async function getOrderValueDistribution(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder)
    WHERE so.totalNetAmount IS NOT NULL
    WITH toFloat(so.totalNetAmount) AS val
    RETURN count(val) AS orderCount,
           round(min(val)*100)/100.0 AS minValue,
           round(max(val)*100)/100.0 AS maxValue,
           round(avg(val)*100)/100.0 AS avgValue,
           round(sum(val)*100)/100.0 AS totalValue
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getOrderValueDistribution');
}

// ── DELIVERY STATUS BREAKDOWN ───────────────────────────────────────────────
export async function getDeliveryStatusBreakdown(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder)
    RETURN so.overallDeliveryStatus AS status, count(so) AS orderCount
    ORDER BY orderCount DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getDeliveryStatusBreakdown');
}

// ── INCOTERMS ANALYSIS ──────────────────────────────────────────────────────
export async function getIncotermsAnalysis(): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder)
    RETURN so.incotermsClassification AS incoterms, count(so) AS orderCount
    ORDER BY orderCount DESC
  `;
  const records = await runQuery(cypher, {});
  return wrapResult(records, 'getIncotermsAnalysis');
}
