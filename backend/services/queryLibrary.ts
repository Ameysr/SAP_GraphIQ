// ── CURATED QUERY LIBRARY ─────────────────────────────────────────────────────
// Production-grade few-shot examples: question → Cypher
// These are embedded at startup and used for vector search

export interface QueryExample {
  question: string;
  cypher: string;
  schemaNodes: string[];  // Which node types this query touches
  embedding?: number[];   // Set at runtime
}

export const QUERY_LIBRARY: QueryExample[] = [

  // ────── LOOKUP ──────
  {
    question: 'Get details about customer 320000083',
    cypher: `MATCH (c:Customer {id: '320000083'})
OPTIONAL MATCH (c)-[:HAS_ADDRESS]->(a:Address)
RETURN c.id AS id, c.businessPartnerFullName AS name, c.businessPartnerIsBlocked AS blocked, a.cityName AS city, a.country AS country`,
    schemaNodes: ['Customer', 'Address'],
  },
  {
    question: 'Show me sales order 740586',
    cypher: `MATCH (so:SalesOrder {salesOrder: '740586'})
OPTIONAL MATCH (c:Customer {id: so.soldToParty})
RETURN so.salesOrder, so.totalNetAmount, so.transactionCurrency, so.overallDeliveryStatus, c.businessPartnerFullName AS customerName`,
    schemaNodes: ['SalesOrder', 'Customer'],
  },
  {
    question: 'What is billing document 91150188?',
    cypher: `MATCH (bh:BillingHeader {billingDocument: '91150188'})
OPTIONAL MATCH (bh)<-[:PART_OF]-(bi:BillingItem)
OPTIONAL MATCH (c:Customer {id: bh.soldToParty})
RETURN bh.billingDocument, bh.totalNetAmount, bh.transactionCurrency, bh.billingDocumentIsCancelled, c.businessPartnerFullName, collect(bi.billingDocumentItem) AS items`,
    schemaNodes: ['BillingHeader', 'BillingItem', 'Customer'],
  },

  // ────── AR AGING ──────
  {
    question: 'Show AR aging buckets for all customers (0-30, 31-60, 61-90, 90+ days)',
    cypher: `MATCH (bh:BillingHeader)
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
ORDER BY aging_90plus DESC`,
    schemaNodes: ['BillingHeader', 'Payment', 'Customer'],
  },
  {
    question: 'What is the open credit exposure per customer?',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false
AND NOT (bh)-[:PAID_BY]->(:Payment)
WITH bh.soldToParty AS cid, sum(toFloat(bh.totalNetAmount)) AS openAmount, count(bh) AS unpaidDocs
MATCH (c:Customer {id: cid})
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       round(openAmount*100)/100.0 AS totalExposure, unpaidDocs
ORDER BY totalExposure DESC LIMIT 20`,
    schemaNodes: ['BillingHeader', 'Payment', 'Customer'],
  },
  {
    question: 'Which invoices are unpaid?',
    cypher: `MATCH (bh:BillingHeader)
WHERE NOT (bh)-[:PAID_BY]->(:Payment) AND bh.billingDocumentIsCancelled <> true
OPTIONAL MATCH (c:Customer {id: bh.soldToParty})
RETURN bh.billingDocument, bh.totalNetAmount AS amount, bh.transactionCurrency AS currency, c.businessPartnerFullName AS customer
ORDER BY toFloat(bh.totalNetAmount) DESC LIMIT 20`,
    schemaNodes: ['BillingHeader', 'Payment', 'Customer'],
  },

  // ────── DSO & PAYMENT ANALYSIS ──────
  {
    question: 'What is the average days sales outstanding (DSO) per customer?',
    cypher: `MATCH (bh:BillingHeader)-[:PAID_BY]->(pay:Payment)
WHERE bh.billingDocumentIsCancelled = false
AND bh.billingDocumentDate IS NOT NULL
AND pay.clearingDate IS NOT NULL
WITH bh.soldToParty AS cid,
     avg(duration.between(date(bh.billingDocumentDate), date(pay.clearingDate)).days) AS avgDSO,
     count(bh) AS paidInvoices
MATCH (c:Customer {id: cid})
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       round(avgDSO*10)/10.0 AS avgDSO_days, paidInvoices
ORDER BY avgDSO DESC`,
    schemaNodes: ['BillingHeader', 'Payment', 'Customer'],
  },
  {
    question: 'Which customers consistently pay late (DSO > 60 days)?',
    cypher: `MATCH (bh:BillingHeader)-[:PAID_BY]->(pay:Payment)
WHERE bh.billingDocumentIsCancelled = false
AND bh.billingDocumentDate IS NOT NULL
AND pay.clearingDate IS NOT NULL
WITH bh.soldToParty AS cid,
     duration.between(date(bh.billingDocumentDate), date(pay.clearingDate)).days AS dso,
     bh
WITH cid,
     count(bh) AS totalPaid,
     sum(CASE WHEN dso > 60 THEN 1 ELSE 0 END) AS latePaid,
     avg(dso) AS avgDSO
MATCH (c:Customer {id: cid})
WITH c, totalPaid, latePaid, round(avgDSO*10)/10.0 AS avgDSO,
     round(toFloat(latePaid)/toFloat(totalPaid)*10000)/100.0 AS lateRate
WHERE lateRate > 50
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       totalPaid, latePaid, lateRate AS latePct, avgDSO
ORDER BY lateRate DESC`,
    schemaNodes: ['BillingHeader', 'Payment', 'Customer'],
  },
  {
    question: 'What is the payment clearing time for all invoices?',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled <> true
MATCH (pay:Payment {accountingDocument: bh.accountingDocument})
WHERE bh.billingDocumentDate IS NOT NULL AND pay.clearingDate IS NOT NULL
WITH bh, pay, date(bh.billingDocumentDate) AS billDate, date(pay.clearingDate) AS clearDate
RETURN bh.billingDocument, bh.billingDocumentDate AS billingDate, pay.clearingDate, duration.between(billDate, clearDate).days AS daysToClear
ORDER BY daysToClear DESC LIMIT 50`,
    schemaNodes: ['BillingHeader', 'Payment'],
  },
  {
    question: 'Which invoices were paid in the same month they were issued?',
    cypher: `MATCH (bh:BillingHeader)-[:PAID_BY]->(pay:Payment)
WHERE bh.billingDocumentDate IS NOT NULL AND pay.clearingDate IS NOT NULL
AND substring(bh.billingDocumentDate, 0, 7) = substring(pay.clearingDate, 0, 7)
AND bh.billingDocumentIsCancelled = false
OPTIONAL MATCH (c:Customer {id: bh.soldToParty})
RETURN bh.billingDocument, bh.billingDocumentDate AS issueDate,
       pay.clearingDate AS paidDate,
       bh.totalNetAmount AS amount, bh.transactionCurrency AS currency,
       c.businessPartnerFullName AS customer
ORDER BY bh.billingDocumentDate DESC LIMIT 30`,
    schemaNodes: ['BillingHeader', 'Payment', 'Customer'],
  },
  {
    question: 'What is the total amount collected via payments per month?',
    cypher: `MATCH (pay:Payment)
WHERE pay.clearingDate IS NOT NULL
WITH substring(pay.clearingDate, 0, 7) AS month,
     sum(toFloat(pay.amountInTransactionCurrency)) AS collected,
     count(pay) AS paymentCount
RETURN month, round(collected*100)/100.0 AS collected, paymentCount
ORDER BY month`,
    schemaNodes: ['Payment'],
  },

  // ────── REVENUE & AGGREGATES ──────
  {
    question: 'Which customers have the highest revenue?',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false
WITH bh.soldToParty AS cid, sum(toFloat(bh.totalNetAmount)) AS rev
MATCH (c:Customer {id: cid})
RETURN c.businessPartnerFullName AS customer, c.id AS customerId, rev, 'INR' AS currency
ORDER BY rev DESC LIMIT 10`,
    schemaNodes: ['BillingHeader', 'Customer'],
  },
  {
    question: 'What percentage of total revenue does each customer contribute?',
    cypher: `MATCH (bh:BillingHeader) WHERE bh.billingDocumentIsCancelled = false
WITH bh.soldToParty AS cid, toFloat(bh.totalNetAmount) AS amount
WITH cid, sum(amount) AS customerRevenue
WITH collect({cid: cid, rev: customerRevenue}) AS all, sum(customerRevenue) AS total
UNWIND all AS c
MATCH (cust:Customer {id: c.cid})
RETURN cust.businessPartnerFullName AS customer, c.rev AS revenue, round(c.rev / total * 10000) / 100.0 AS pct
ORDER BY c.rev DESC`,
    schemaNodes: ['BillingHeader', 'Customer'],
  },
  {
    question: 'What is the total revenue per sales organization?',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false
MATCH (so:SalesOrder {salesOrder: bh.salesDocument})
RETURN so.salesOrganization AS org, sum(toFloat(bh.totalNetAmount)) AS totalRevenue, bh.transactionCurrency AS currency
ORDER BY totalRevenue DESC`,
    schemaNodes: ['BillingHeader', 'SalesOrder'],
  },
  {
    question: 'How many orders does each customer have?',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
RETURN c.id AS customerId, c.businessPartnerFullName AS customer, count(so) AS orderCount
ORDER BY orderCount DESC`,
    schemaNodes: ['Customer', 'SalesOrder'],
  },
  {
    question: 'What is the distribution of sales order values (min, max, avg, total)?',
    cypher: `MATCH (so:SalesOrder)
WHERE so.totalNetAmount IS NOT NULL
WITH toFloat(so.totalNetAmount) AS val
RETURN count(val) AS orderCount,
       round(min(val)*100)/100.0 AS minValue,
       round(max(val)*100)/100.0 AS maxValue,
       round(avg(val)*100)/100.0 AS avgValue,
       round(sum(val)*100)/100.0 AS totalValue`,
    schemaNodes: ['SalesOrder'],
  },
  {
    question: 'Show me orders with unusually high value (above 3x average)',
    cypher: `MATCH (so:SalesOrder)
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
ORDER BY orderValue DESC`,
    schemaNodes: ['SalesOrder', 'Customer'],
  },

  // ────── PRODUCT ANALYSIS ──────
  {
    question: 'What are the top products by billing frequency?',
    cypher: `MATCH (bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false
MATCH (soi:SalesOrderItem {salesOrder: bi.referenceSdDocument, material: bi.material})-[:REFERENCES]->(p:Product)
RETURN p.productDescription AS product, count(DISTINCT bh) AS billingCount
ORDER BY billingCount DESC LIMIT 10`,
    schemaNodes: ['BillingItem', 'BillingHeader', 'SalesOrderItem', 'Product'],
  },
  {
    question: 'What is the revenue contribution of each product?',
    cypher: `MATCH (bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false
MATCH (soi:SalesOrderItem {salesOrder: bi.referenceSdDocument, material: bi.material})-[:REFERENCES]->(p:Product)
WITH p, sum(toFloat(bi.netAmount)) AS productRevenue, count(DISTINCT bh) AS invoiceCount
WITH collect({product: p.productDescription, rev: productRevenue, invoiceCount: invoiceCount}) AS all,
     sum(productRevenue) AS grandTotal
UNWIND all AS pr
RETURN pr.product AS product,
       round(pr.rev*100)/100.0 AS revenue,
       pr.invoiceCount AS invoices,
       round(pr.rev/grandTotal*10000)/100.0 AS revenuePct
ORDER BY pr.rev DESC LIMIT 20`,
    schemaNodes: ['BillingItem', 'BillingHeader', 'SalesOrderItem', 'Product'],
  },
  {
    question: 'Which products are ordered by only one customer (single-customer products)?',
    cypher: `MATCH (soi:SalesOrderItem)-[:REFERENCES]->(p:Product)
OPTIONAL MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi)
WITH p, collect(DISTINCT so.soldToParty) AS customers
WHERE size(customers) = 1
RETURN p.product AS productId, p.productDescription AS product,
       customers[0] AS soloCustomerId
ORDER BY p.productDescription`,
    schemaNodes: ['SalesOrderItem', 'Product', 'SalesOrder'],
  },
  {
    question: 'Which products were ordered but never delivered?',
    cypher: `MATCH (soi:SalesOrderItem)-[:REFERENCES]->(p:Product)
WHERE NOT EXISTS { MATCH (soi)-[:FULFILLED_BY]->(:DeliveryItem) }
WITH p, collect(DISTINCT soi.salesOrder) AS orders
RETURN p.product AS productId, p.productDescription AS product, orders
ORDER BY p.productDescription`,
    schemaNodes: ['SalesOrderItem', 'Product', 'DeliveryItem'],
  },

  // ────── DELIVERY PERFORMANCE ──────
  {
    question: 'What is the average delivery lead time from order to delivery per customer?',
    cypher: `MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)-[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
WHERE so.creationDate IS NOT NULL AND dh.deliveryDate IS NOT NULL
WITH so.soldToParty AS cid,
     avg(duration.between(date(so.creationDate), date(dh.deliveryDate)).days) AS avgLeadDays,
     count(DISTINCT dh) AS deliveries
MATCH (c:Customer {id: cid})
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       round(avgLeadDays*10)/10.0 AS avgLeadDays, deliveries
ORDER BY avgLeadDays DESC`,
    schemaNodes: ['SalesOrder', 'SalesOrderItem', 'DeliveryItem', 'DeliveryHeader', 'Customer'],
  },
  {
    question: 'Which deliveries are overdue (confirmed date passed but not yet fully billed)?',
    cypher: `MATCH (soi:SalesOrderItem)-[:HAS_SCHEDULE_LINE]->(sl:ScheduleLine)
WHERE sl.confirmedDeliveryDate IS NOT NULL
AND date(sl.confirmedDeliveryDate) < date()
AND NOT EXISTS { MATCH (soi)-[:FULFILLED_BY]->(:DeliveryItem) }
OPTIONAL MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi)
OPTIONAL MATCH (c:Customer {id: so.soldToParty})
RETURN so.salesOrder, soi.salesOrderItem,
       sl.confirmedDeliveryDate AS confirmedDate,
       duration.between(date(sl.confirmedDeliveryDate), date()).days AS daysOverdue,
       c.businessPartnerFullName AS customer
ORDER BY daysOverdue DESC LIMIT 20`,
    schemaNodes: ['SalesOrderItem', 'ScheduleLine', 'SalesOrder', 'Customer', 'DeliveryItem'],
  },
  {
    question: 'Find orders that were never delivered',
    cypher: `MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)
WHERE NOT EXISTS { MATCH (soi)-[:FULFILLED_BY]->(:DeliveryItem) }
RETURN so.salesOrder AS orderId, so.soldToParty AS customer, count(soi) AS undeliveredItems
ORDER BY undeliveredItems DESC LIMIT 20`,
    schemaNodes: ['SalesOrder', 'SalesOrderItem', 'DeliveryItem'],
  },
  {
    question: 'Which customers have 0% delivery fulfillment rate?',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)
WITH c, so, soi
OPTIONAL MATCH (soi)-[:FULFILLED_BY]->(di:DeliveryItem)
WITH c, count(DISTINCT soi) AS totalItems, count(DISTINCT di) AS deliveredItems, collect(DISTINCT so.salesOrder) AS orderIds
WITH c, totalItems, deliveredItems, orderIds,
     CASE WHEN totalItems = 0 THEN 0 ELSE round(toFloat(deliveredItems) / toFloat(totalItems) * 10000) / 100.0 END AS rate
RETURN c.businessPartnerFullName AS customer, c.id AS customerId, totalItems, deliveredItems, rate AS fulfillmentRate, orderIds
ORDER BY rate ASC`,
    schemaNodes: ['Customer', 'SalesOrder', 'SalesOrderItem', 'DeliveryItem'],
  },
  {
    question: 'Find orders delivered but never billed',
    cypher: `MATCH (dh:DeliveryHeader)<-[:PART_OF]-(di:DeliveryItem)
WHERE NOT EXISTS {
  MATCH (dh)-[:BILLED_IN]->(:BillingItem)-[:PART_OF]->(:BillingHeader)
}
OPTIONAL MATCH (soi:SalesOrderItem)-[:FULFILLED_BY]->(di)
OPTIONAL MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi)
OPTIONAL MATCH (c:Customer {id: so.soldToParty})
RETURN dh.deliveryDocument AS deliveryId,
       so.salesOrder AS salesOrder,
       c.businessPartnerFullName AS customer,
       count(DISTINCT di) AS deliveredItems
ORDER BY deliveredItems DESC LIMIT 20`,
    schemaNodes: ['DeliveryHeader', 'DeliveryItem', 'BillingItem', 'BillingHeader', 'SalesOrderItem', 'SalesOrder', 'Customer'],
  },
  {
    question: 'What is the overall delivery status breakdown?',
    cypher: `MATCH (so:SalesOrder)
RETURN so.overallDeliveryStatus AS status, count(so) AS orderCount
ORDER BY orderCount DESC`,
    schemaNodes: ['SalesOrder'],
  },
  {
    question: 'Which delivery has the most distinct products?',
    cypher: `MATCH (soi:SalesOrderItem)-[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
MATCH (soi)-[:REFERENCES]->(p:Product)
WITH dh.deliveryDocument AS delivery, collect(DISTINCT p.productDescription) AS products
RETURN delivery, size(products) AS productCount, products[..5] AS sampleProducts
ORDER BY productCount DESC LIMIT 10`,
    schemaNodes: ['SalesOrderItem', 'DeliveryItem', 'DeliveryHeader', 'Product'],
  },
  {
    question: 'What products are in delivery 800066830?',
    cypher: `MATCH (soi:SalesOrderItem)-[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader {deliveryDocument: '800066830'})
MATCH (soi)-[:REFERENCES]->(p:Product)
RETURN dh.deliveryDocument, p.product AS productId, p.productDescription, di.actualDeliveryQuantity AS qty`,
    schemaNodes: ['SalesOrderItem', 'DeliveryItem', 'DeliveryHeader', 'Product'],
  },
  {
    question: 'How many deliveries does each plant handle?',
    cypher: `MATCH (di:DeliveryItem)-[:AT_PLANT]->(pl:Plant)
WITH pl, count(DISTINCT di) AS deliveryItemCount
RETURN pl.plant AS plantId, pl.plantName AS plantName, deliveryItemCount
ORDER BY deliveryItemCount DESC`,
    schemaNodes: ['DeliveryItem', 'Plant'],
  },

  // ────── CANCELLATIONS & RETURNS ──────
  {
    question: 'Which customers have the most billing cancellations?',
    cypher: `MATCH (bc:BillingCancellation)-[:CANCELS]->(bh:BillingHeader)
WITH bh.soldToParty AS cid,
     count(bc) AS cancellations,
     sum(toFloat(bh.totalNetAmount)) AS cancelledValue
MATCH (c:Customer {id: cid})
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       cancellations, round(cancelledValue*100)/100.0 AS cancelledValue
ORDER BY cancellations DESC LIMIT 15`,
    schemaNodes: ['BillingCancellation', 'BillingHeader', 'Customer'],
  },
  {
    question: 'What is the cancellation rate by customer (cancelled vs total billing documents)?',
    cypher: `MATCH (bh:BillingHeader)
WITH bh.soldToParty AS cid, count(bh) AS totalDocs,
     sum(CASE WHEN bh.billingDocumentIsCancelled = true THEN 1 ELSE 0 END) AS cancelledDocs
MATCH (c:Customer {id: cid})
WITH c, totalDocs, cancelledDocs,
     round(toFloat(cancelledDocs)/toFloat(totalDocs)*10000)/100.0 AS cancellationRate
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       totalDocs, cancelledDocs, cancellationRate
ORDER BY cancellationRate DESC`,
    schemaNodes: ['BillingHeader', 'Customer'],
  },
  {
    question: 'Which billing documents were cancelled?',
    cypher: `MATCH (bc:BillingCancellation)-[:CANCELS]->(bh:BillingHeader)
OPTIONAL MATCH (c:Customer {id: bh.soldToParty})
RETURN bh.billingDocument AS originalDoc, bc.billingDocument AS cancelDoc, bh.totalNetAmount AS amount, bh.transactionCurrency, c.businessPartnerFullName AS customer
ORDER BY toFloat(bh.totalNetAmount) DESC LIMIT 20`,
    schemaNodes: ['BillingCancellation', 'BillingHeader', 'Customer'],
  },
  {
    question: 'Find billing documents cancelled after payment was received',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = true
MATCH (pay:Payment {accountingDocument: bh.accountingDocument})
WHERE pay.clearingDate IS NOT NULL
RETURN bh.billingDocument, bh.totalNetAmount, pay.clearingDate, bh.soldToParty AS customer
ORDER BY toFloat(bh.totalNetAmount) DESC LIMIT 20`,
    schemaNodes: ['BillingHeader', 'Payment'],
  },
  {
    question: 'Which sales organization has the highest cancellation rate?',
    cypher: `MATCH (so:SalesOrder)<-[:REFERENCES]-(soi:SalesOrderItem)<-[:PART_OF]-(bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
WITH so.salesOrganization AS org, count(bh) AS total,
     sum(CASE WHEN bh.billingDocumentIsCancelled = true THEN 1 ELSE 0 END) AS cancelled
RETURN org,
       total,
       cancelled,
       round(toFloat(cancelled)/toFloat(total)*10000)/100.0 AS cancellationRate
ORDER BY cancellationRate DESC`,
    schemaNodes: ['SalesOrder', 'SalesOrderItem', 'BillingItem', 'BillingHeader'],
  },

  // ────── JOURNAL ENTRY ANALYSIS ──────
  {
    question: 'What is the total debit vs credit amount across all journal entries?',
    cypher: `MATCH (je:JournalEntry)
WITH toFloat(je.amountInTransactionCurrency) AS amount
RETURN sum(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS totalDebits,
       sum(CASE WHEN amount < 0 THEN abs(amount) ELSE 0 END) AS totalCredits,
       round(sum(amount)*100)/100.0 AS netBalance,
       count(je) AS totalEntries`,
    schemaNodes: ['JournalEntry'],
  },
  {
    question: 'Which billing documents generated the largest journal entry amounts?',
    cypher: `MATCH (bh:BillingHeader)-[:POSTED_AS]->(je:JournalEntry)
WHERE bh.billingDocumentIsCancelled = false
WITH bh, sum(abs(toFloat(je.amountInTransactionCurrency))) AS jeTotal, count(je) AS jeCount
OPTIONAL MATCH (c:Customer {id: bh.soldToParty})
RETURN bh.billingDocument, c.businessPartnerFullName AS customer,
       bh.totalNetAmount AS billingAmount,
       round(jeTotal*100)/100.0 AS journalTotal,
       jeCount AS journalLines,
       bh.transactionCurrency AS currency
ORDER BY jeTotal DESC LIMIT 20`,
    schemaNodes: ['BillingHeader', 'JournalEntry', 'Customer'],
  },
  {
    question: 'How are journal entries distributed between customers?',
    cypher: `MATCH (bh:BillingHeader)-[:POSTED_AS]->(je:JournalEntry)
WITH bh.soldToParty AS customerId, je, toFloat(je.amountInTransactionCurrency) AS amount
WITH customerId, count(je) AS totalEntries,
     sum(CASE WHEN amount > 0 THEN 1 ELSE 0 END) AS positiveEntries,
     sum(CASE WHEN amount < 0 THEN 1 ELSE 0 END) AS negativeEntries,
     sum(amount) AS netAmount
MATCH (c:Customer {id: customerId})
RETURN c.businessPartnerFullName AS customer, totalEntries, positiveEntries, negativeEntries, round(netAmount * 100) / 100.0 AS netAmount
ORDER BY totalEntries DESC`,
    schemaNodes: ['BillingHeader', 'JournalEntry', 'Customer'],
  },
  {
    question: 'Find journal entries with no corresponding billing document',
    cypher: `MATCH (je:JournalEntry)
WHERE NOT EXISTS { MATCH (bh:BillingHeader)-[:POSTED_AS]->(je) }
RETURN je.accountingDocument AS accountingDoc,
       je.amountInTransactionCurrency AS amount,
       je.transactionCurrency AS currency,
       je.postingDate AS postingDate
ORDER BY toFloat(je.amountInTransactionCurrency) DESC LIMIT 20`,
    schemaNodes: ['JournalEntry', 'BillingHeader'],
  },
  {
    question: 'Which billing documents have no journal entries?',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false AND NOT EXISTS { MATCH (bh)-[:POSTED_AS]->(:JournalEntry) }
RETURN bh.billingDocument, bh.totalNetAmount, bh.transactionCurrency, bh.soldToParty
ORDER BY toFloat(bh.totalNetAmount) DESC LIMIT 20`,
    schemaNodes: ['BillingHeader', 'JournalEntry'],
  },

  // ────── CURRENCY & MULTI-CURRENCY ──────
  {
    question: 'What currencies are used across billing documents?',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false
RETURN bh.transactionCurrency AS currency,
       count(bh) AS documentCount,
       round(sum(toFloat(bh.totalNetAmount))*100)/100.0 AS totalAmount
ORDER BY documentCount DESC`,
    schemaNodes: ['BillingHeader'],
  },
  {
    question: 'Which customers transact in multiple currencies?',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false
WITH bh.soldToParty AS cid, collect(DISTINCT bh.transactionCurrency) AS currencies
WHERE size(currencies) > 1
MATCH (c:Customer {id: cid})
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       currencies, size(currencies) AS currencyCount
ORDER BY currencyCount DESC`,
    schemaNodes: ['BillingHeader', 'Customer'],
  },

  // ────── CUSTOMER RISK & BLOCKED ──────
  {
    question: 'Find customers who have open orders AND unpaid invoices AND are blocked',
    cypher: `MATCH (c:Customer)
WHERE c.businessPartnerIsBlocked = true
AND EXISTS { MATCH (c)-[:PLACED]->(so:SalesOrder) WHERE so.overallDeliveryStatus <> 'C' }
AND EXISTS {
  MATCH (bh:BillingHeader)
  WHERE bh.soldToParty = c.id
  AND bh.billingDocumentIsCancelled = false
  AND NOT (bh)-[:PAID_BY]->(:Payment)
}
MATCH (c)-[:PLACED]->(so:SalesOrder)
WHERE so.overallDeliveryStatus <> 'C'
WITH c, count(DISTINCT so) AS openOrders
MATCH (bh:BillingHeader)
WHERE bh.soldToParty = c.id
AND bh.billingDocumentIsCancelled = false
AND NOT (bh)-[:PAID_BY]->(:Payment)
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       openOrders,
       count(bh) AS unpaidInvoices,
       round(sum(toFloat(bh.totalNetAmount))*100)/100.0 AS unpaidAmount
ORDER BY unpaidAmount DESC`,
    schemaNodes: ['Customer', 'SalesOrder', 'BillingHeader', 'Payment'],
  },
  {
    question: 'Are there any blocked customers with active orders?',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
WHERE c.businessPartnerIsBlocked = true
RETURN c.businessPartnerFullName AS customer, c.id AS customerId, count(so) AS orderCount, sum(toFloat(so.totalNetAmount)) AS totalValue
ORDER BY totalValue DESC`,
    schemaNodes: ['Customer', 'SalesOrder'],
  },
  {
    question: 'Which customers have no billing documents at all?',
    cypher: `MATCH (c:Customer)
WHERE NOT EXISTS { MATCH (bh:BillingHeader) WHERE bh.soldToParty = c.id }
RETURN c.id AS customerId, c.businessPartnerFullName AS customer, c.businessPartnerIsBlocked AS blocked
ORDER BY c.businessPartnerFullName`,
    schemaNodes: ['Customer', 'BillingHeader'],
  },

  // ────── CUSTOMER ORDER RECENCY ──────
  {
    question: 'Which customers have not placed any orders in the last 6 months?',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
WHERE so.creationDate IS NOT NULL
WITH c, max(date(so.creationDate)) AS lastOrderDate
WHERE lastOrderDate < date() - duration('P6M')
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       lastOrderDate,
       duration.between(lastOrderDate, date()).days AS daysSinceLastOrder
ORDER BY daysSinceLastOrder DESC`,
    schemaNodes: ['Customer', 'SalesOrder'],
  },
  {
    question: 'Who are the most recently acquired customers (first order date)?',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
WHERE so.creationDate IS NOT NULL
WITH c, min(date(so.creationDate)) AS firstOrderDate, count(so) AS totalOrders
RETURN c.businessPartnerFullName AS customer, c.id AS customerId,
       firstOrderDate, totalOrders
ORDER BY firstOrderDate DESC LIMIT 20`,
    schemaNodes: ['Customer', 'SalesOrder'],
  },

  // ────── PAYMENT TERMS ──────
  {
    question: 'Which customers use payment terms Z001 vs Z009?',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
WITH c, so.customerPaymentTerms AS paymentTerm, count(so) AS orderCount
RETURN c.id AS customerId, c.businessPartnerFullName AS customer, paymentTerm, orderCount
ORDER BY paymentTerm, c.businessPartnerFullName`,
    schemaNodes: ['Customer', 'SalesOrder'],
  },

  // ────── SALES ORDER & DISTRIBUTION ──────
  {
    question: 'What incoterms are used across sales orders?',
    cypher: `MATCH (so:SalesOrder)
RETURN so.incotermsClassification AS incoterms, count(so) AS orderCount
ORDER BY orderCount DESC`,
    schemaNodes: ['SalesOrder'],
  },
  {
    question: 'How are orders split by distribution channel?',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
RETURN so.distributionChannel AS channel, count(so) AS orderCount, count(DISTINCT c) AS customerCount
ORDER BY orderCount DESC`,
    schemaNodes: ['SalesOrder', 'Customer'],
  },
  {
    question: 'Which orders have schedule lines with late confirmed dates?',
    cypher: `MATCH (so:SalesOrder)-[:HAS_ITEM]->(soi:SalesOrderItem)-[:HAS_SCHEDULE_LINE]->(sl:ScheduleLine)
WHERE sl.confirmedDeliveryDate IS NOT NULL
RETURN so.salesOrder, soi.salesOrderItem, sl.confirmedDeliveryDate
ORDER BY sl.confirmedDeliveryDate DESC LIMIT 20`,
    schemaNodes: ['SalesOrder', 'SalesOrderItem', 'ScheduleLine'],
  },

  // ────── TRAVERSE & O2C JOURNEY ──────
  {
    question: 'Trace the full O2C journey for sales order 740586',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder {salesOrder: '740586'})-[:HAS_ITEM]->(soi:SalesOrderItem)
OPTIONAL MATCH (soi)-[:REFERENCES]->(p:Product)
OPTIONAL MATCH (soi)-[:FULFILLED_BY]->(di:DeliveryItem)-[:PART_OF]->(dh:DeliveryHeader)
OPTIONAL MATCH (dh)-[:BILLED_IN]->(bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
OPTIONAL MATCH (bh)-[:POSTED_AS]->(je:JournalEntry)
OPTIONAL MATCH (bh)-[:PAID_BY]->(pay:Payment)
RETURN so.salesOrder, soi.salesOrderItem, p.productDescription, dh.deliveryDocument, bh.billingDocument, bh.billingDocumentIsCancelled, pay.clearingDate`,
    schemaNodes: ['Customer', 'SalesOrder', 'SalesOrderItem', 'Product', 'DeliveryItem', 'DeliveryHeader', 'BillingItem', 'BillingHeader', 'JournalEntry', 'Payment'],
  },
  {
    question: 'Find the most expensive billing item',
    cypher: `MATCH (bi:BillingItem)-[:PART_OF]->(bh:BillingHeader)
WITH bi, bh, toFloat(bi.netAmount) AS amount
ORDER BY amount DESC LIMIT 10
OPTIONAL MATCH (soi:SalesOrderItem {salesOrder: bi.referenceSdDocument, material: bi.material})-[:REFERENCES]->(p:Product)
OPTIONAL MATCH (cust:Customer {id: bh.soldToParty})
RETURN bi.billingDocument, bi.billingDocumentItem, bi.netAmount, bh.transactionCurrency, p.productDescription, bh.billingDocumentIsCancelled, cust.businessPartnerFullName AS customer
ORDER BY toFloat(bi.netAmount) DESC`,
    schemaNodes: ['BillingItem', 'BillingHeader', 'SalesOrderItem', 'Product', 'Customer'],
  },

  // ────── COMPARE ──────
  {
    question: 'Compare revenue between customer 320000083 and 320000082',
    cypher: `MATCH (bh:BillingHeader)
WHERE bh.billingDocumentIsCancelled = false AND bh.soldToParty IN ['320000083', '320000082']
WITH bh.soldToParty AS cid, sum(toFloat(bh.totalNetAmount)) AS revenue, count(bh) AS docCount
MATCH (c:Customer {id: cid})
RETURN c.businessPartnerFullName AS customer, revenue, docCount, bh.transactionCurrency AS currency
ORDER BY revenue DESC`,
    schemaNodes: ['BillingHeader', 'Customer'],
  },

  // ────── DATE RANGE & TEMPORAL PATTERNS ──────
  {
    question: 'Show orders placed in April 2025',
    cypher: `MATCH (so:SalesOrder)
WHERE so.creationDate STARTS WITH '2025-04'
OPTIONAL MATCH (c:Customer {id: so.soldToParty})
RETURN so.salesOrder, so.creationDate, so.totalNetAmount, so.transactionCurrency, c.businessPartnerFullName AS customer
ORDER BY so.creationDate DESC LIMIT 50`,
    schemaNodes: ['SalesOrder', 'Customer'],
  },
  {
    question: 'Show the 5 most recent orders by creation date',
    cypher: `MATCH (so:SalesOrder)
WHERE so.creationDate IS NOT NULL
OPTIONAL MATCH (c:Customer {id: so.soldToParty})
RETURN so.salesOrder, so.creationDate, toFloat(so.totalNetAmount) AS amount, so.transactionCurrency, c.businessPartnerFullName AS customer
ORDER BY so.creationDate DESC LIMIT 5`,
    schemaNodes: ['SalesOrder', 'Customer'],
  },
  {
    question: 'What deliveries were created between April 1 and April 15, 2025?',
    cypher: `MATCH (dh:DeliveryHeader)
WHERE date(dh.creationDate) >= date('2025-04-01') AND date(dh.creationDate) < date('2025-04-16')
RETURN dh.deliveryDocument, dh.creationDate, dh.overallGoodsMovementStatus
ORDER BY dh.creationDate DESC`,
    schemaNodes: ['DeliveryHeader'],
  },

  // ────── SIMPLE LIST & PERCENTAGE PATTERNS ──────
  {
    question: 'List all plants with their names',
    cypher: `MATCH (pl:Plant)
RETURN pl.plant AS plantId, pl.plantName AS plantName
ORDER BY pl.plantName`,
    schemaNodes: ['Plant'],
  },
  {
    question: 'List all customers',
    cypher: `MATCH (c:Customer)
RETURN c.id AS customerId, c.businessPartnerFullName AS name, c.businessPartnerIsBlocked AS blocked
ORDER BY c.businessPartnerFullName LIMIT 50`,
    schemaNodes: ['Customer'],
  },
  {
    question: 'What percentage of orders have been fully delivered?',
    cypher: `MATCH (so:SalesOrder)
WITH count(so) AS total,
     sum(CASE WHEN so.overallDeliveryStatus = 'C' THEN 1 ELSE 0 END) AS fullyDelivered
RETURN total AS totalOrders, fullyDelivered,
       round(toFloat(fullyDelivered) / toFloat(total) * 10000) / 100.0 AS deliveredPct`,
    schemaNodes: ['SalesOrder'],
  },

  // ────── CROSS-DOMAIN SUMMARY ──────
  {
    question: 'For each customer, show order count, delivery count, and billing total',
    cypher: `MATCH (c:Customer)-[:PLACED]->(so:SalesOrder)
WITH c, count(DISTINCT so) AS orders
OPTIONAL MATCH (c)-[:PLACED]->(:SalesOrder)-[:HAS_ITEM]->(:SalesOrderItem)-[:FULFILLED_BY]->(di:DeliveryItem)
WITH c, orders, count(DISTINCT di) AS deliveries
OPTIONAL MATCH (bh:BillingHeader) WHERE bh.soldToParty = c.id AND bh.billingDocumentIsCancelled = false
WITH c, orders, deliveries, sum(toFloat(bh.totalNetAmount)) AS billingTotal
RETURN c.businessPartnerFullName AS customer, orders, deliveries, round(billingTotal * 100) / 100.0 AS billingTotal
ORDER BY billingTotal DESC`,
    schemaNodes: ['Customer', 'SalesOrder', 'SalesOrderItem', 'DeliveryItem', 'BillingHeader'],
  },
  {
    question: 'Give me a full O2C health summary: orders, deliveries, billing, and payments',
    cypher: `MATCH (so:SalesOrder) WITH count(so) AS totalOrders
MATCH (dh:DeliveryHeader) WITH totalOrders, count(dh) AS totalDeliveries
MATCH (bh:BillingHeader) WHERE bh.billingDocumentIsCancelled = false
WITH totalOrders, totalDeliveries, count(bh) AS totalInvoices,
     sum(toFloat(bh.totalNetAmount)) AS totalBilled
MATCH (pay:Payment)
WITH totalOrders, totalDeliveries, totalInvoices,
     round(totalBilled*100)/100.0 AS totalBilled,
     count(pay) AS totalPayments,
     round(sum(toFloat(pay.amountInTransactionCurrency))*100)/100.0 AS totalCollected
RETURN totalOrders, totalDeliveries, totalInvoices, totalBilled, totalPayments, totalCollected`,
    schemaNodes: ['SalesOrder', 'DeliveryHeader', 'BillingHeader', 'Payment'],
  },



  // ────── REVENUE LEAKAGE ──────
  {
    question: 'Which deliveries were shipped but never invoiced?',
    cypher: `MATCH (dh:DeliveryHeader)
WHERE NOT (dh)-[:BILLED_IN]->(:BillingItem)
OPTIONAL MATCH (dh)<-[:PART_OF]-(di:DeliveryItem)
OPTIONAL MATCH (di)<-[:FULFILLED_BY]-(soi:SalesOrderItem)
OPTIONAL MATCH (soi)<-[:HAS_ITEM]-(so:SalesOrder)
OPTIONAL MATCH (c:Customer {id: so.soldToParty})
RETURN dh.deliveryDocument AS deliveryDocument, dh.creationDate AS deliveryDate,
       dh.overallGoodsMovementStatus AS status, so.salesOrder AS salesOrder,
       c.businessPartnerFullName AS customer
ORDER BY dh.creationDate DESC
LIMIT 50`,
    schemaNodes: ['DeliveryHeader', 'DeliveryItem', 'SalesOrderItem', 'SalesOrder', 'Customer'],
  },
];