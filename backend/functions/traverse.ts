import { runQuery } from '../db.js';
import type { FunctionResult, QueryResult } from '../types/index.js';

function wrapResult(records: QueryResult[], funcName: string): FunctionResult {
  return { records, metadata: { count: records.length, functionName: funcName } };
}

export async function traceDocument(billingDocId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader {id: $billingDocId})
    OPTIONAL MATCH (bh)<-[:PART_OF]-(bi:BillingItem)<-[:BILLED_IN]-(dh:DeliveryHeader)
    OPTIONAL MATCH (dh)<-[:PART_OF]-(di:DeliveryItem)<-[:FULFILLED_BY]-(soi:SalesOrderItem)
    OPTIONAL MATCH (soi)<-[:HAS_ITEM]-(so:SalesOrder)<-[:PLACED]-(c:Customer)
    OPTIONAL MATCH (bh)-[:POSTED_AS]->(je:JournalEntry)
    OPTIONAL MATCH (bh)-[:PAID_BY]->(pay:Payment)
    RETURN c, so, dh, bh, collect(DISTINCT je) AS journalEntries, pay
  `;
  const records = await runQuery(cypher, { billingDocId });
  return wrapResult(records, 'traceDocument');
}

export async function getOrderDeliveries(orderId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder {id: $orderId})-[:HAS_ITEM]->(soi:SalesOrderItem)
          -[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
    OPTIONAL MATCH (di)-[:AT_PLANT]->(pl:Plant)
    RETURN so, collect(DISTINCT {delivery: dh, item: di, plant: pl}) AS deliveries
  `;
  const records = await runQuery(cypher, { orderId });
  return wrapResult(records, 'getOrderDeliveries');
}

export async function getDeliveryBilling(deliveryId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (dh:DeliveryHeader {id: $deliveryId})-[:BILLED_IN]->(bi:BillingItem)
          -[:PART_OF]->(bh:BillingHeader)
    OPTIONAL MATCH (bh)-[:PAID_BY]->(pay:Payment)
    RETURN dh, collect({billingItem: bi, billingHeader: bh, payment: pay}) AS billing
  `;
  const records = await runQuery(cypher, { deliveryId });
  return wrapResult(records, 'getDeliveryBilling');
}

export async function traceOrderJourney(orderId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer)-[:PLACED]->(so:SalesOrder {salesOrder: $orderId})-[:HAS_ITEM]->(soi:SalesOrderItem)
    OPTIONAL MATCH (soi)-[:REFERENCES]->(p:Product)
    OPTIONAL MATCH (soi)-[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
    OPTIONAL MATCH (dh)-[:BILLED_IN]->(bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
    WHERE bh IS NULL OR bh.billingDocumentIsCancelled = false
    OPTIONAL MATCH (bh)-[:POSTED_AS]->(je:JournalEntry)
    OPTIONAL MATCH (bh)-[:PAID_BY]->(pay:Payment)
    RETURN so.salesOrder AS salesOrder,
           so.creationDate AS orderCreationDate,
           so.totalNetAmount AS orderAmount,
           so.transactionCurrency AS currency,
           c.businessPartnerFullName AS customerName,
           c.id AS customerId,
           soi.salesOrderItem AS itemNumber,
           soi.material AS material,
           p.productDescription AS productDescription,
           soi.netAmount AS itemAmount,
           soi.requestedQuantity AS orderedQty,
           dh.deliveryDocument AS deliveryDocument,
           dh.creationDate AS deliveryDocCreatedDate,
           dh.actualGoodsMovementDate AS actualGoodsMovementDate,
           di.actualDeliveryQuantity AS deliveredQty,
           bh.billingDocument AS billingDocument,
           bh.billingDocumentDate AS billingDate,
           bh.creationDate AS billingCreatedDate,
           bh.totalNetAmount AS billedAmount,
           je.accountingDocument AS accountingDocument,
           pay.clearingDate AS paymentDate,
           pay.amountInTransactionCurrency AS paymentAmount
    ORDER BY soi.salesOrderItem
  `;
  const records = await runQuery(cypher, { orderId });
  return wrapResult(records, 'traceOrderJourney');
}
