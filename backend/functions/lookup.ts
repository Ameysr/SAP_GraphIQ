import { runQuery } from '../db.js';
import type { FunctionResult, QueryResult } from '../types/index.js';

function wrapResult(records: QueryResult[], funcName: string): FunctionResult {
  return { records, metadata: { count: records.length, functionName: funcName } };
}

export async function getCustomer(customerId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (c:Customer {id: $customerId})
    OPTIONAL MATCH (c)-[:HAS_ADDRESS]->(a:Address)
    OPTIONAL MATCH (c)-[:ASSIGNED_TO_COMPANY]->(cc:CustomerCompany)
    RETURN c, a, cc
  `;
  const records = await runQuery(cypher, { customerId });
  return wrapResult(records, 'getCustomer');
}

export async function getOrder(orderId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (so:SalesOrder {id: $orderId})
    OPTIONAL MATCH (so)<-[:PLACED]-(c:Customer)
    OPTIONAL MATCH (so)-[:HAS_ITEM]->(soi:SalesOrderItem)
    RETURN so, c, collect(soi) AS items
  `;
  const records = await runQuery(cypher, { orderId });
  return wrapResult(records, 'getOrder');
}

export async function getProduct(productId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (p:Product {id: $productId})
    OPTIONAL MATCH (p)-[:STOCKED_AT]->(pp:ProductPlant)-[:IN_PLANT]->(pl:Plant)
    RETURN p, collect({plant: pl, productPlant: pp}) AS plantData
  `;
  const records = await runQuery(cypher, { productId });
  return wrapResult(records, 'getProduct');
}

export async function getBillingDoc(billingDocId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (bh:BillingHeader {id: $billingDocId})
    OPTIONAL MATCH (bh)-[:PAID_BY]->(pay:Payment)
    OPTIONAL MATCH (bh)-[:POSTED_AS]->(je:JournalEntry)
    OPTIONAL MATCH (bh)<-[:PART_OF]-(bi:BillingItem)
    RETURN bh, pay, collect(DISTINCT je) AS journalEntries, collect(DISTINCT bi) AS items
  `;
  const records = await runQuery(cypher, { billingDocId });
  return wrapResult(records, 'getBillingDoc');
}

export async function getDelivery(deliveryId: string): Promise<FunctionResult> {
  const cypher = `
    MATCH (dh:DeliveryHeader {id: $deliveryId})
    OPTIONAL MATCH (dh)<-[:PART_OF]-(di:DeliveryItem)-[:AT_PLANT]->(pl:Plant)
    RETURN dh, collect({item: di, plant: pl}) AS itemsWithPlants
  `;
  const records = await runQuery(cypher, { deliveryId });
  return wrapResult(records, 'getDelivery');
}
