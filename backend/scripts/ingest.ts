import { getDriver } from '../db.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const DATA_DIR = path.resolve(process.cwd(), '..', 'data');
const BATCH_SIZE = 100;
const NEO4J_DATABASE = process.env.NEO4J_DATABASE ?? 'neo4j';

type RawRecord = Record<string, unknown>;

function str(val: unknown): string {
  if (val === null || val === undefined) return '';
  return String(val);
}

function toBool(val: unknown, defaultVal: boolean): boolean {
  if (val === null || val === undefined) return defaultVal;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (['true', 't', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', 'f', '0', 'no', 'n', ''].includes(s)) return false;
  }
  return defaultVal;
}

function normalizeItemNumber(val: unknown): string {
  // SalesOrderItem uses "10","20",... while DeliveryItem referenceSdDocumentItem is "000010".
  // Normalize to non-padded numeric string so IDs match consistently.
  const s = str(val);
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return s;
  return String(n);
}

// ──────────────────────── JSONL Reader ────────────────────────
async function readJsonlFiles(collectionDir: string): Promise<RawRecord[]> {
  const records: RawRecord[] = [];
  const files = fs.readdirSync(collectionDir).filter((f) => f.endsWith('.jsonl'));

  for (const file of files) {
    const filePath = path.join(collectionDir, file);
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as RawRecord);
      } catch {
        console.warn(`  Skipped malformed line in ${file}`);
      }
    }
  }
  return records;
}

// ──────────────────────── Batch Execute ────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function batchMerge(
  cypher: string,
  records: RawRecord[],
  paramsFn: (rec: RawRecord) => Record<string, unknown>,
  collectionName: string
): Promise<{ processed: number; skipped: number }> {
  const driver = getDriver();
  let processed = 0;
  let skipped = 0;

  // Use smaller batches for large collections to avoid Aura free tier limits
  const effectiveBatchSize = records.length > 1000 ? 50 : BATCH_SIZE;

  for (let i = 0; i < records.length; i += effectiveBatchSize) {
    const batch = records.slice(i, i + effectiveBatchSize);
    const session = driver.session({ database: NEO4J_DATABASE });

    try {
      await session.executeWrite(async (tx) => {
        for (const rec of batch) {
          try {
            const params = paramsFn(rec);
            await tx.run(cypher, params);
            processed++;
          } catch (err: unknown) {
            skipped++;
            if (skipped <= 3) {
              console.warn(`  Skipped record in ${collectionName}:`, err instanceof Error ? err.message.substring(0, 100) : '');
            }
          }
        }
      });
    } catch (err: unknown) {
      console.error(`  Batch error in ${collectionName}:`, err instanceof Error ? err.message.substring(0, 100) : '');
      skipped += batch.length;
    } finally {
      await session.close();
    }

    // Throttle for large collections to avoid overwhelming Aura free tier
    if (records.length > 1000 && i + effectiveBatchSize < records.length) {
      await sleep(500);
    }
  }

  return { processed, skipped };
}

// ──────────────────────── PASS 1: NODES ────────────────────────
interface NodeConfig {
  label: string;
  folder: string;
  idFn: (r: RawRecord) => string;
  propsFn: (r: RawRecord) => Record<string, unknown>;
  extraCypher?: string;
}

const NODE_CONFIGS: NodeConfig[] = [
  {
    label: 'Customer',
    folder: 'business_partners',
    idFn: (r) => str(r.businessPartner),
    propsFn: (r) => ({
      businessPartner: str(r.businessPartner),
      customer: str(r.customer),
      businessPartnerFullName: str(r.businessPartnerFullName),
      businessPartnerName: str(r.businessPartnerName),
      businessPartnerCategory: str(r.businessPartnerCategory),
      businessPartnerGrouping: str(r.businessPartnerGrouping),
      businessPartnerIsBlocked: toBool(r.businessPartnerIsBlocked, false),
      isMarkedForArchiving: toBool(r.isMarkedForArchiving, false),
      creationDate: str(r.creationDate),
      lastChangeDate: str(r.lastChangeDate),
    }),
  },
  {
    label: 'SalesOrder',
    folder: 'sales_order_headers',
    idFn: (r) => str(r.salesOrder),
    propsFn: (r) => ({
      salesOrder: str(r.salesOrder),
      salesOrderType: str(r.salesOrderType),
      salesOrganization: str(r.salesOrganization),
      distributionChannel: str(r.distributionChannel),
      organizationDivision: str(r.organizationDivision),
      soldToParty: str(r.soldToParty),
      creationDate: str(r.creationDate),
      totalNetAmount: str(r.totalNetAmount),
      overallDeliveryStatus: str(r.overallDeliveryStatus),
      overallOrdReltdBillgStatus: str(r.overallOrdReltdBillgStatus),
      transactionCurrency: str(r.transactionCurrency),
      requestedDeliveryDate: str(r.requestedDeliveryDate),
      customerPaymentTerms: str(r.customerPaymentTerms),
      incotermsClassification: str(r.incotermsClassification),
    }),
  },
  {
    label: 'SalesOrderItem',
    folder: 'sales_order_items',
    idFn: (r) => str(r.salesOrder) + '_' + str(r.salesOrderItem),
    propsFn: (r) => ({
      salesOrder: str(r.salesOrder),
      salesOrderItem: str(r.salesOrderItem),
      material: str(r.material),
      requestedQuantity: str(r.requestedQuantity),
      requestedQuantityUnit: str(r.requestedQuantityUnit),
      netAmount: str(r.netAmount),
      transactionCurrency: str(r.transactionCurrency),
      materialGroup: str(r.materialGroup),
      productionPlant: str(r.productionPlant),
      storageLocation: str(r.storageLocation),
      salesDocumentRjcnReason: str(r.salesDocumentRjcnReason),
      itemBillingBlockReason: str(r.itemBillingBlockReason),
      salesOrderItemCategory: str(r.salesOrderItemCategory),
    }),
  },
  {
    label: 'ScheduleLine',
    folder: 'sales_order_schedule_lines',
    idFn: (r) => str(r.salesOrder) + '_' + str(r.salesOrderItem) + '_' + str(r.scheduleLine),
    propsFn: (r) => ({
      salesOrder: str(r.salesOrder),
      salesOrderItem: str(r.salesOrderItem),
      scheduleLine: str(r.scheduleLine),
      confirmedDeliveryDate: str(r.confirmedDeliveryDate),
      orderQuantityUnit: str(r.orderQuantityUnit),
      confdOrderQtyByMatlAvailCheck: str(r.confdOrderQtyByMatlAvailCheck),
    }),
  },
  {
    label: 'Product',
    folder: 'products',
    idFn: (r) => str(r.product),
    propsFn: (r) => ({
      product: str(r.product),
      baseUnit: str(r.baseUnit),
      productGroup: str(r.productGroup),
      division: str(r.division),
      grossWeight: str(r.grossWeight),
      netWeight: str(r.netWeight),
      weightUnit: str(r.weightUnit),
      productHierarchy: str(r.productHierarchy),
      productType: str(r.productType),
      isMarkedForArchiving: toBool(r.isMarkedForArchiving, false),
    }),
  },
  {
    label: 'ProductDescription',
    folder: 'product_descriptions',
    idFn: (r) => str(r.product) + '_' + str(r.language),
    propsFn: (r) => ({
      product: str(r.product),
      language: str(r.language),
      productDescription: str(r.productDescription),
    }),
  },
  {
    label: 'DeliveryHeader',
    folder: 'outbound_delivery_headers',
    idFn: (r) => str(r.deliveryDocument),
    propsFn: (r) => ({
      deliveryDocument: str(r.deliveryDocument),
      creationDate: str(r.creationDate),
      shippingPoint: str(r.shippingPoint),
      deliveryBlockReason: str(r.deliveryBlockReason),
      headerBillingBlockReason: str(r.headerBillingBlockReason),
      overallGoodsMovementStatus: str(r.overallGoodsMovementStatus),
      overallPickingStatus: str(r.overallPickingStatus),
      hdrGeneralIncompletionStatus: str(r.hdrGeneralIncompletionStatus),
      actualGoodsMovementDate: str(r.actualGoodsMovementDate),
    }),
  },
  {
    label: 'DeliveryItem',
    folder: 'outbound_delivery_items',
    idFn: (r) => str(r.deliveryDocument) + '_' + str(r.deliveryDocumentItem),
    propsFn: (r) => ({
      deliveryDocument: str(r.deliveryDocument),
      deliveryDocumentItem: str(r.deliveryDocumentItem),
      plant: str(r.plant),
      storageLocation: str(r.storageLocation),
      referenceSdDocument: str(r.referenceSdDocument),
      referenceSdDocumentItem: str(r.referenceSdDocumentItem),
      actualDeliveryQuantity: str(r.actualDeliveryQuantity),
      deliveryQuantityUnit: str(r.deliveryQuantityUnit),
      batch: str(r.batch),
      itemBillingBlockReason: str(r.itemBillingBlockReason),
    }),
  },
  {
    label: 'BillingHeader',
    folder: 'billing_document_headers',
    idFn: (r) => str(r.billingDocument),
    propsFn: (r) => ({
      billingDocument: str(r.billingDocument),
      billingDocumentType: str(r.billingDocumentType),
      billingDocumentDate: str(r.billingDocumentDate),
      creationDate: str(r.creationDate),
      totalNetAmount: str(r.totalNetAmount),
      transactionCurrency: str(r.transactionCurrency),
      companyCode: str(r.companyCode),
      fiscalYear: str(r.fiscalYear),
      accountingDocument: str(r.accountingDocument),
      soldToParty: str(r.soldToParty),
      billingDocumentIsCancelled: toBool(r.billingDocumentIsCancelled, false),
      cancelledBillingDocument: str(r.cancelledBillingDocument),
      lastChangeDateTime: str(r.lastChangeDateTime),
    }),
  },
  {
    label: 'BillingItem',
    folder: 'billing_document_items',
    idFn: (r) => str(r.billingDocument) + '_' + str(r.billingDocumentItem),
    propsFn: (r) => ({
      billingDocument: str(r.billingDocument),
      billingDocumentItem: str(r.billingDocumentItem),
      material: str(r.material),
      billingQuantity: str(r.billingQuantity),
      billingQuantityUnit: str(r.billingQuantityUnit),
      netAmount: str(r.netAmount),
      transactionCurrency: str(r.transactionCurrency),
      referenceSdDocument: str(r.referenceSdDocument),
      referenceSdDocumentItem: str(r.referenceSdDocumentItem),
    }),
  },
  {
    label: 'BillingCancellation',
    folder: 'billing_document_cancellations',
    idFn: (r) => str(r.billingDocument),
    propsFn: (r) => ({
      billingDocument: str(r.billingDocument),
      billingDocumentType: str(r.billingDocumentType),
      billingDocumentDate: str(r.billingDocumentDate),
      creationDate: str(r.creationDate),
      totalNetAmount: str(r.totalNetAmount),
      transactionCurrency: str(r.transactionCurrency),
      companyCode: str(r.companyCode),
      fiscalYear: str(r.fiscalYear),
      accountingDocument: str(r.accountingDocument),
      soldToParty: str(r.soldToParty),
      billingDocumentIsCancelled: toBool(r.billingDocumentIsCancelled, true),
      cancelledBillingDocument: str(r.cancelledBillingDocument),
    }),
  },
  {
    label: 'JournalEntry',
    folder: 'journal_entry_items_accounts_receivable',
    idFn: (r) => str(r.accountingDocument) + '_' + str(r.accountingDocumentItem),
    propsFn: (r) => ({
      accountingDocument: str(r.accountingDocument),
      accountingDocumentItem: str(r.accountingDocumentItem),
      glAccount: str(r.glAccount),
      referenceDocument: str(r.referenceDocument),
      companyCode: str(r.companyCode),
      fiscalYear: str(r.fiscalYear),
      transactionCurrency: str(r.transactionCurrency),
      amountInTransactionCurrency: str(r.amountInTransactionCurrency),
      companyCodeCurrency: str(r.companyCodeCurrency),
      amountInCompanyCodeCurrency: str(r.amountInCompanyCodeCurrency),
      postingDate: str(r.postingDate),
      documentDate: str(r.documentDate),
      accountingDocumentType: str(r.accountingDocumentType),
      customer: str(r.customer),
      profitCenter: str(r.profitCenter),
      costCenter: str(r.costCenter),
      clearingDate: str(r.clearingDate),
      clearingAccountingDocument: str(r.clearingAccountingDocument),
      financialAccountType: str(r.financialAccountType),
    }),
  },
  {
    label: 'Payment',
    folder: 'payments_accounts_receivable',
    idFn: (r) => str(r.accountingDocument) + '_' + str(r.accountingDocumentItem),
    propsFn: (r) => ({
      accountingDocument: str(r.accountingDocument),
      accountingDocumentItem: str(r.accountingDocumentItem),
      companyCode: str(r.companyCode),
      fiscalYear: str(r.fiscalYear),
      clearingDate: str(r.clearingDate),
      clearingAccountingDocument: str(r.clearingAccountingDocument),
      amountInTransactionCurrency: str(r.amountInTransactionCurrency),
      transactionCurrency: str(r.transactionCurrency),
      amountInCompanyCodeCurrency: str(r.amountInCompanyCodeCurrency),
      companyCodeCurrency: str(r.companyCodeCurrency),
      customer: str(r.customer),
      postingDate: str(r.postingDate),
      documentDate: str(r.documentDate),
      glAccount: str(r.glAccount),
      financialAccountType: str(r.financialAccountType),
      profitCenter: str(r.profitCenter),
      costCenter: str(r.costCenter),
    }),
  },
  {
    label: 'Plant',
    folder: 'plants',
    idFn: (r) => str(r.plant),
    propsFn: (r) => ({
      plant: str(r.plant),
      plantName: str(r.plantName),
      valuationArea: str(r.valuationArea),
      salesOrganization: str(r.salesOrganization),
      distributionChannel: str(r.distributionChannel),
      division: str(r.division),
      language: str(r.language),
      addressId: str(r.addressId),
      isMarkedForArchiving: toBool(r.isMarkedForArchiving, false),
      factoryCalendar: str(r.factoryCalendar),
    }),
  },
  {
    label: 'Address',
    folder: 'business_partner_addresses',
    idFn: (r) => str(r.businessPartner) + '_' + str(r.addressId),
    propsFn: (r) => ({
      businessPartner: str(r.businessPartner),
      addressId: str(r.addressId),
      cityName: str(r.cityName),
      country: str(r.country),
      postalCode: str(r.postalCode),
      region: str(r.region),
      streetName: str(r.streetName),
      addressTimeZone: str(r.addressTimeZone),
      validityStartDate: str(r.validityStartDate),
      validityEndDate: str(r.validityEndDate),
    }),
  },
  {
    label: 'CustomerCompany',
    folder: 'customer_company_assignments',
    idFn: (r) => str(r.customer) + '_' + str(r.companyCode),
    propsFn: (r) => ({
      customer: str(r.customer),
      companyCode: str(r.companyCode),
      reconciliationAccount: str(r.reconciliationAccount),
      paymentTerms: str(r.paymentTerms),
      paymentBlockingReason: str(r.paymentBlockingReason),
      customerAccountGroup: str(r.customerAccountGroup),
      deletionIndicator: toBool(r.deletionIndicator, false),
    }),
  },
  {
    label: 'CustomerSalesArea',
    folder: 'customer_sales_area_assignments',
    idFn: (r) => str(r.customer) + '_' + str(r.salesOrganization) + '_' + str(r.distributionChannel),
    propsFn: (r) => ({
      customer: str(r.customer),
      salesOrganization: str(r.salesOrganization),
      distributionChannel: str(r.distributionChannel),
      division: str(r.division),
      currency: str(r.currency),
      customerPaymentTerms: str(r.customerPaymentTerms),
      incotermsClassification: str(r.incotermsClassification),
      incotermsLocation1: str(r.incotermsLocation1),
      shippingCondition: str(r.shippingCondition),
      billingIsBlockedForCustomer: toBool(r.billingIsBlockedForCustomer, false),
      completeDeliveryIsDefined: toBool(r.completeDeliveryIsDefined, false),
    }),
  },
  {
    label: 'ProductPlant',
    folder: 'product_plants',
    idFn: (r) => str(r.product) + '_' + str(r.plant),
    propsFn: (r) => ({
      product: str(r.product),
      plant: str(r.plant),
      countryOfOrigin: str(r.countryOfOrigin),
      availabilityCheckType: str(r.availabilityCheckType),
      profitCenter: str(r.profitCenter),
      mrpType: str(r.mrpType),
    }),
  },
  {
    label: 'ProductStorageLocation',
    folder: 'product_storage_locations',
    idFn: (r) => str(r.product) + '_' + str(r.plant) + '_' + str(r.storageLocation),
    propsFn: (r) => ({
      product: str(r.product),
      plant: str(r.plant),
      storageLocation: str(r.storageLocation),
      physicalInventoryBlockInd: str(r.physicalInventoryBlockInd),
      dateOfLastPostedCntUnRstrcdStk: str(r.dateOfLastPostedCntUnRstrcdStk),
    }),
  },
];

async function ingestNodes(): Promise<void> {
  console.log('\n═══════════════════════════════════════');
  console.log('  PASS 1: CREATING NODES');
  console.log('═══════════════════════════════════════\n');

  for (const config of NODE_CONFIGS) {
    const collectionDir = path.join(DATA_DIR, config.folder);
    if (!fs.existsSync(collectionDir)) {
      console.warn(`⚠ Collection folder not found: ${config.folder} — skipping`);
      continue;
    }

    console.log(`[${config.label}] Reading ${config.folder}...`);
    const records = await readJsonlFiles(collectionDir);
    console.log(`  Found ${records.length} records`);

    if (records.length === 0) continue;

    // Build dynamic MERGE Cypher
    const sampleProps = config.propsFn(records[0]);
    const propSetClauses = Object.keys(sampleProps)
      .map((k) => `n.${k} = $props.${k}`)
      .join(', ');

    const cypher = `MERGE (n:${config.label} {id: $id}) SET ${propSetClauses}`;

    const { processed, skipped } = await batchMerge(
      cypher,
      records,
      (rec) => ({ id: config.idFn(rec), props: config.propsFn(rec) }),
      config.label
    );

    console.log(`  ✓ ${config.label}: ${processed} processed, ${skipped} skipped`);

    // Special: ProductDescription → also update Product node
    if (config.label === 'ProductDescription') {
      console.log('  Updating Product nodes with descriptions...');
      const driver = getDriver();
      let descUpdated = 0;
      for (const rec of records) {
        try {
          const session = driver.session({ database: NEO4J_DATABASE });
          try {
            await session.executeWrite(async (tx) => {
              await tx.run(
                `MATCH (p:Product {id: $productId})
                 SET p.productDescription = $description, p.language = $language`,
                {
                  productId: str(rec.product),
                  description: str(rec.productDescription),
                  language: str(rec.language),
                }
              );
            });
            descUpdated++;
          } finally {
            await session.close();
          }
        } catch {
          // silently skip
        }
      }
      console.log(`  ✓ Updated ${descUpdated} Product descriptions`);
    }
  }
}

// ──────────────────────── PASS 2: RELATIONSHIPS ────────────────────────
interface RelConfig {
  name: string;
  sourceFolder: string;
  cypher: string;
  paramsFn: (r: RawRecord) => Record<string, unknown>;
}

const REL_CONFIGS: RelConfig[] = [
  {
    name: 'Customer-PLACED->SalesOrder',
    sourceFolder: 'sales_order_headers',
    cypher: `
      MATCH (c:Customer {id: $soldToParty})
      MATCH (so:SalesOrder {id: $salesOrder})
      MERGE (c)-[:PLACED]->(so)
    `,
    paramsFn: (r) => ({ soldToParty: str(r.soldToParty), salesOrder: str(r.salesOrder) }),
  },
  {
    name: 'SalesOrder-HAS_ITEM->SalesOrderItem',
    sourceFolder: 'sales_order_items',
    cypher: `
      MATCH (so:SalesOrder {id: $salesOrder})
      MATCH (soi:SalesOrderItem {id: $itemId})
      MERGE (so)-[:HAS_ITEM]->(soi)
    `,
    paramsFn: (r) => ({
      salesOrder: str(r.salesOrder),
      itemId: str(r.salesOrder) + '_' + str(r.salesOrderItem),
    }),
  },
  {
    name: 'SalesOrderItem-HAS_SCHEDULE_LINE->ScheduleLine',
    sourceFolder: 'sales_order_schedule_lines',
    cypher: `
      MATCH (soi:SalesOrderItem {id: $itemId})
      MATCH (sl:ScheduleLine {id: $slId})
      MERGE (soi)-[:HAS_SCHEDULE_LINE]->(sl)
    `,
    paramsFn: (r) => ({
      itemId: str(r.salesOrder) + '_' + str(r.salesOrderItem),
      slId: str(r.salesOrder) + '_' + str(r.salesOrderItem) + '_' + str(r.scheduleLine),
    }),
  },
  {
    name: 'SalesOrderItem-REFERENCES->Product',
    sourceFolder: 'sales_order_items',
    cypher: `
      MATCH (soi:SalesOrderItem {id: $itemId})
      MATCH (p:Product {id: $material})
      MERGE (soi)-[:REFERENCES]->(p)
    `,
    paramsFn: (r) => ({
      itemId: str(r.salesOrder) + '_' + str(r.salesOrderItem),
      material: str(r.material),
    }),
  },
  {
    name: 'SalesOrderItem-FULFILLED_BY->DeliveryItem',
    sourceFolder: 'outbound_delivery_items',
    cypher: `
      MATCH (soi:SalesOrderItem {id: $soiId})
      MATCH (di:DeliveryItem {id: $diId})
      MERGE (soi)-[:FULFILLED_BY]->(di)
    `,
    paramsFn: (r) => ({
      soiId: str(r.referenceSdDocument) + '_' + normalizeItemNumber(r.referenceSdDocumentItem),
      diId: str(r.deliveryDocument) + '_' + str(r.deliveryDocumentItem),
    }),
  },
  {
    name: 'DeliveryItem-PART_OF->DeliveryHeader',
    sourceFolder: 'outbound_delivery_items',
    cypher: `
      MATCH (di:DeliveryItem {id: $diId})
      MATCH (dh:DeliveryHeader {id: $dhId})
      MERGE (di)-[:PART_OF]->(dh)
    `,
    paramsFn: (r) => ({
      diId: str(r.deliveryDocument) + '_' + str(r.deliveryDocumentItem),
      dhId: str(r.deliveryDocument),
    }),
  },
  {
    name: 'DeliveryItem-AT_PLANT->Plant',
    sourceFolder: 'outbound_delivery_items',
    cypher: `
      MATCH (di:DeliveryItem {id: $diId})
      MATCH (pl:Plant {id: $plant})
      MERGE (di)-[:AT_PLANT]->(pl)
    `,
    paramsFn: (r) => ({
      diId: str(r.deliveryDocument) + '_' + str(r.deliveryDocumentItem),
      plant: str(r.plant),
    }),
  },
  {
    name: 'DeliveryHeader-BILLED_IN->BillingItem',
    sourceFolder: 'billing_document_items',
    cypher: `
      MATCH (dh:DeliveryHeader {id: $refDoc})
      MATCH (bi:BillingItem {id: $biId})
      MERGE (dh)-[:BILLED_IN]->(bi)
    `,
    paramsFn: (r) => ({
      refDoc: str(r.referenceSdDocument),
      biId: str(r.billingDocument) + '_' + str(r.billingDocumentItem),
    }),
  },
  {
    name: 'BillingItem-PART_OF->BillingHeader',
    sourceFolder: 'billing_document_items',
    cypher: `
      MATCH (bi:BillingItem {id: $biId})
      MATCH (bh:BillingHeader {id: $bhId})
      MERGE (bi)-[:PART_OF]->(bh)
    `,
    paramsFn: (r) => ({
      biId: str(r.billingDocument) + '_' + str(r.billingDocumentItem),
      bhId: str(r.billingDocument),
    }),
  },
  {
    name: 'BillingHeader-POSTED_AS->JournalEntry',
    sourceFolder: 'billing_document_headers',
    cypher: `
      MATCH (bh:BillingHeader {id: $bhId})
      MATCH (je:JournalEntry)
      WHERE je.accountingDocument = $accDoc
      MERGE (bh)-[:POSTED_AS]->(je)
    `,
    paramsFn: (r) => ({
      bhId: str(r.billingDocument),
      accDoc: str(r.accountingDocument),
    }),
  },
  {
    name: 'BillingHeader-PAID_BY->Payment',
    sourceFolder: 'billing_document_headers',
    cypher: `
      MATCH (bh:BillingHeader {id: $bhId})
      MATCH (pay:Payment)
      WHERE pay.accountingDocument = $accDoc
      MERGE (bh)-[:PAID_BY]->(pay)
    `,
    paramsFn: (r) => ({
      bhId: str(r.billingDocument),
      accDoc: str(r.accountingDocument),
    }),
  },
  {
    name: 'BillingCancellation-CANCELS->BillingHeader',
    sourceFolder: 'billing_document_cancellations',
    cypher: `
      MATCH (bc:BillingCancellation {id: $bcId})
      MATCH (bh:BillingHeader {id: $bhId})
      WHERE bc.id <> bh.id OR bc.billingDocumentIsCancelled = true
      MERGE (bc)-[:CANCELS]->(bh)
    `,
    paramsFn: (r) => ({
      bcId: str(r.billingDocument),
      bhId: str(r.cancelledBillingDocument || r.billingDocument),
    }),
  },
  {
    name: 'Customer-HAS_ADDRESS->Address',
    sourceFolder: 'business_partner_addresses',
    cypher: `
      MATCH (c:Customer {id: $bp})
      MATCH (a:Address {id: $addrId})
      MERGE (c)-[:HAS_ADDRESS]->(a)
    `,
    paramsFn: (r) => ({
      bp: str(r.businessPartner),
      addrId: str(r.businessPartner) + '_' + str(r.addressId),
    }),
  },
  {
    name: 'Customer-ASSIGNED_TO_COMPANY->CustomerCompany',
    sourceFolder: 'customer_company_assignments',
    cypher: `
      MATCH (c:Customer {id: $customer})
      MATCH (cc:CustomerCompany {id: $ccId})
      MERGE (c)-[:ASSIGNED_TO_COMPANY]->(cc)
    `,
    paramsFn: (r) => ({
      customer: str(r.customer),
      ccId: str(r.customer) + '_' + str(r.companyCode),
    }),
  },
  {
    name: 'Customer-SELLS_THROUGH->CustomerSalesArea',
    sourceFolder: 'customer_sales_area_assignments',
    cypher: `
      MATCH (c:Customer {id: $customer})
      MATCH (csa:CustomerSalesArea {id: $csaId})
      MERGE (c)-[:SELLS_THROUGH]->(csa)
    `,
    paramsFn: (r) => ({
      customer: str(r.customer),
      csaId: str(r.customer) + '_' + str(r.salesOrganization) + '_' + str(r.distributionChannel),
    }),
  },
  {
    name: 'Product-STOCKED_AT->ProductPlant',
    sourceFolder: 'product_plants',
    cypher: `
      MATCH (p:Product {id: $product})
      MATCH (pp:ProductPlant {id: $ppId})
      MERGE (p)-[:STOCKED_AT]->(pp)
    `,
    paramsFn: (r) => ({
      product: str(r.product),
      ppId: str(r.product) + '_' + str(r.plant),
    }),
  },
  {
    name: 'ProductPlant-IN_PLANT->Plant',
    sourceFolder: 'product_plants',
    cypher: `
      MATCH (pp:ProductPlant {id: $ppId})
      MATCH (pl:Plant {id: $plant})
      MERGE (pp)-[:IN_PLANT]->(pl)
    `,
    paramsFn: (r) => ({
      ppId: str(r.product) + '_' + str(r.plant),
      plant: str(r.plant),
    }),
  },
  {
    name: 'ProductStorageLocation-FOR_PRODUCT->Product',
    sourceFolder: 'product_storage_locations',
    cypher: `
      MATCH (psl:ProductStorageLocation {id: $pslId})
      MATCH (p:Product {id: $product})
      MERGE (psl)-[:FOR_PRODUCT]->(p)
    `,
    paramsFn: (r) => ({
      pslId: str(r.product) + '_' + str(r.plant) + '_' + str(r.storageLocation),
      product: str(r.product),
    }),
  },
];

async function ingestRelationships(): Promise<void> {
  console.log('\n═══════════════════════════════════════');
  console.log('  PASS 2: CREATING RELATIONSHIPS');
  console.log('═══════════════════════════════════════\n');

  for (const rel of REL_CONFIGS) {
    const collectionDir = path.join(DATA_DIR, rel.sourceFolder);
    if (!fs.existsSync(collectionDir)) {
      console.warn(`⚠ Collection folder not found: ${rel.sourceFolder} — skipping ${rel.name}`);
      continue;
    }

    console.log(`[${rel.name}] Reading ${rel.sourceFolder}...`);
    const records = await readJsonlFiles(collectionDir);

    if (records.length === 0) {
      console.log(`  No records found, skipping`);
      continue;
    }

    const { processed, skipped } = await batchMerge(
      rel.cypher,
      records,
      rel.paramsFn,
      rel.name
    );

    console.log(`  ✓ ${rel.name}: ${processed} processed, ${skipped} skipped`);
  }
}

// ──────────────────────── MAIN ────────────────────────
async function createIndexes(): Promise<void> {
  console.log('\nCreating indexes...');
  const driver = getDriver();
  const session = driver.session({ database: NEO4J_DATABASE });
  try {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS FOR (n:Customer) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:SalesOrder) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:SalesOrderItem) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:ScheduleLine) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:Product) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:DeliveryHeader) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:DeliveryItem) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:BillingHeader) ON (n.id)',
      // Required for efficient joins used by functions like getPaymentClearingTime().
      'CREATE INDEX IF NOT EXISTS FOR (n:BillingHeader) ON (n.accountingDocument)',
      // Helps customer-centric queries (soldToParty is a common filter key).
      'CREATE INDEX IF NOT EXISTS FOR (n:BillingHeader) ON (n.soldToParty)',
      'CREATE INDEX IF NOT EXISTS FOR (n:BillingItem) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:BillingCancellation) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:JournalEntry) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:JournalEntry) ON (n.accountingDocument)',
      'CREATE INDEX IF NOT EXISTS FOR (n:Payment) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:Payment) ON (n.accountingDocument)',
      'CREATE INDEX IF NOT EXISTS FOR (n:Plant) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:Address) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:CustomerCompany) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:CustomerSalesArea) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:ProductPlant) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:ProductStorageLocation) ON (n.id)',
      'CREATE INDEX IF NOT EXISTS FOR (n:ProductDescription) ON (n.id)',
    ];

    for (const idx of indexes) {
      try {
        await session.run(idx);
      } catch {
        // Index might already exist
      }
    }
    console.log('✓ Indexes created');
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║  SAP O2C Data Ingestion                   ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`Data directory: ${DATA_DIR}`);

  if (!fs.existsSync(DATA_DIR)) {
    console.error(`ERROR: Data directory not found: ${DATA_DIR}`);
    console.error('Make sure to copy sap-o2c-data/ to data/ at the project root');
    process.exit(1);
  }

  const startTime = Date.now();

  try {
    await createIndexes();
    await ingestNodes();
    await ingestRelationships();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✓ Ingestion complete in ${elapsed}s`);
  } catch (err: unknown) {
    console.error('Ingestion failed:', err);
    process.exit(1);
  } finally {
    const driver = getDriver();
    await driver.close();
  }
}

main();
