import { runQuery } from '../db.js';
import type { FunctionResult, QueryResult } from '../types/index.js';

function wrapResult(records: QueryResult[], funcName: string): FunctionResult {
  return { records, metadata: { count: records.length, functionName: funcName } };
}

export async function compareCustomerRevenue(customerId1: string, customerId2: string): Promise<FunctionResult> {
  const cypher = `
    UNWIND [$id1, $id2] AS cid
    MATCH (c:Customer {id: cid})
    OPTIONAL MATCH (bh:BillingHeader {soldToParty: cid})
    WHERE bh.billingDocumentIsCancelled = false
    OPTIONAL MATCH (bhc:BillingHeader {soldToParty: cid})
    WHERE bhc.billingDocumentIsCancelled = true
    OPTIONAL MATCH (bhp:BillingHeader {soldToParty: cid})-[:PAID_BY]->(:Payment)
    WHERE bhp.billingDocumentIsCancelled = false
    RETURN c.id AS customerId,
           c.businessPartnerFullName AS customerName,
           count(DISTINCT bh) AS activeBillingDocs,
           count(DISTINCT bhc) AS cancelledBillingDocs,
           sum(toFloat(bh.totalNetAmount)) AS totalRevenue,
           count(DISTINCT bhp) AS paidDocs,
           head(collect(bh.transactionCurrency)) AS currency
    ORDER BY totalRevenue DESC
  `;
  const records = await runQuery(cypher, { id1: customerId1, id2: customerId2 });
  return wrapResult(records, 'compareCustomerRevenue');
}

export async function compareCustomerOrders(customerId1: string, customerId2: string): Promise<FunctionResult> {
  const cypher = `
    UNWIND [$id1, $id2] AS cid
    MATCH (c:Customer {id: cid})
    OPTIONAL MATCH (c)-[:PLACED]->(so:SalesOrder)
    OPTIONAL MATCH (so)-[:HAS_ITEM]->(soi:SalesOrderItem)-[:FULFILLED_BY]->(:DeliveryItem)
    RETURN c.id AS customerId,
           c.businessPartnerFullName AS customerName,
           c.businessPartnerIsBlocked AS isBlocked,
           count(DISTINCT so) AS totalOrders,
           sum(toFloat(so.totalNetAmount)) AS totalOrderValue,
           count(DISTINCT soi) AS itemsWithDeliveries,
           head(collect(so.transactionCurrency)) AS currency
    ORDER BY totalOrders DESC
  `;
  const records = await runQuery(cypher, { id1: customerId1, id2: customerId2 });
  return wrapResult(records, 'compareCustomerOrders');
}
