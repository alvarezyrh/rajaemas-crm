import { Errors } from '../../core/errors.js';
import { EMAIL_PATTERN } from '../../shared/email.js';
import { normalizeIndonesianPhone } from '../../shared/phone.js';
import { extractList, getPath, mapRecord } from './mapping.js';

const SERVICE_TYPES = new Set(['APPRAISAL', 'BUYBACK', 'CONSULTATION']);
const MAX_DATASET_RECORD_BYTES = 100_000;
const MAX_TRANSACTION_ITEMS = 50;

export const INTEGRATION_TARGETS = Object.freeze([
  'CUSTOMER',
  'PRODUCT',
  'LEAD',
  'APPOINTMENT',
  'TRANSACTION',
  'DATASET',
]);

export const REQUIRED_TARGET_FIELDS = Object.freeze({
  CUSTOMER: ['fullName', 'phone'],
  PRODUCT: ['sku', 'name'],
  LEAD: ['fullName', 'phone'],
  APPOINTMENT: ['externalId', 'branchCode', 'serviceType', 'scheduledAt'],
  TRANSACTION: ['externalId', 'branchCode', 'transactionTypeCode', 'items'],
  DATASET: ['externalId'],
});

const text = (value, max = 500) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result ? result.slice(0, max) : null;
};

const number = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
};

const boolean = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return undefined;
};

const mapped = (record, fieldMap, key) =>
  fieldMap[key] ? getPath(record, fieldMap[key]) : undefined;

function required(record, fieldMap, key, label = key, max) {
  const value = text(getPath(record, fieldMap[key]), max);
  if (!value) throw Errors.validation([{ field: key, message: `${label} is required` }]);
  return value;
}

function validKey(record, fieldMap) {
  const key = required(record, fieldMap, 'externalId', 'external record ID', 200);
  return key;
}

function keyHash(blindIndex, source, key) {
  return blindIndex('integration-record', `${source.id}:${key}`);
}

async function customerIdFor(source, record, fieldMap, uow, blindIndex) {
  const accountId = text(mapped(record, fieldMap, 'customerAccountId'), 128);
  if (accountId && source.channel) {
    const customerId = await uow.repos.segments.findCustomerIdByAccount(source.channel, accountId);
    if (customerId) return customerId;
  }
  const rawPhone = text(mapped(record, fieldMap, 'customerPhone'), 40);
  const phone = rawPhone ? normalizeIndonesianPhone(rawPhone) : null;
  if (rawPhone && !phone)
    throw Errors.validation([{ field: 'customerPhone', message: 'is not a valid phone number' }]);
  if (phone) return uow.repos.customers.findIdByPhoneHash(blindIndex('phone', phone));
  return null;
}

function branchFor(record, fieldMap, branches) {
  const code = required(record, fieldMap, 'branchCode', 'outlet code', 32);
  const branch = branches.find((item) => item.code.toLowerCase() === code.toLowerCase());
  if (!branch)
    throw Errors.validation([{ field: 'branchCode', message: 'is not an active outlet' }]);
  return branch;
}

export function createIntegrationTargets({
  uow,
  pii,
  blindIndex,
  intake,
  leads,
  appointments,
  transactions,
  masterdata,
}) {
  async function prepare(source) {
    if (source.targetType === 'PRODUCT') {
      const [products, categories] = await Promise.all([
        uow.repos.products.list({ includeInactive: true }),
        uow.repos.productCategories.list({ includeInactive: true }),
      ]);
      return {
        productBySku: new Map(products.map((product) => [product.sku.toLowerCase(), product])),
        categoryByCode: new Map(
          categories.map((category) => [category.code.toLowerCase(), category]),
        ),
      };
    }
    if (source.targetType === 'LEAD' || source.targetType === 'APPOINTMENT') {
      const [branches, areas, references] = await Promise.all([
        uow.repos.branches.listActive(),
        source.targetType === 'LEAD' ? uow.repos.areas.list({ includeInactive: true }) : [],
        source.targetType === 'LEAD' ? uow.repos.references.list({ includeInactive: true }) : [],
      ]);
      return {
        branches,
        areaByCode: new Map(areas.map((area) => [area.code.toLowerCase(), area])),
        referenceByCode: new Map(
          references.map((reference) => [reference.code.toLowerCase(), reference]),
        ),
      };
    }
    if (source.targetType === 'TRANSACTION') {
      const [branches, products, types] = await Promise.all([
        uow.repos.branches.listActive(),
        uow.repos.products.list(),
        uow.repos.transactionTypes.list({ includeInactive: true }),
      ]);
      return {
        branches,
        productBySku: new Map(products.map((product) => [product.sku.toLowerCase(), product])),
        typeByCode: new Map(types.map((type) => [type.code.toLowerCase(), type])),
      };
    }
    return {};
  }

  async function importCustomer(source, record) {
    const mapped = mapRecord(record, source.fieldMap);
    if (!mapped.ok) return { status: 'skipped', reason: mapped.reason };
    const result = await intake.upsert(mapped.value, {
      actor: source.actor,
      channel: source.channel,
      source: `API: ${source.name}`,
    });
    const invalid = mapped.rejected.length ? `ignored invalid ${mapped.rejected.join(', ')}` : null;
    return {
      ...result,
      reason: [result.reason, invalid].filter(Boolean).join('; ') || undefined,
    };
  }

  async function importProduct(source, record, actor, context) {
    const sku = required(record, source.fieldMap, 'sku', 'SKU', 64);
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(sku))
      throw Errors.validation([{ field: 'sku', message: 'has an invalid format' }]);
    const existing = context.productBySku.get(sku.toLowerCase());
    if (existing) return { status: 'matched' };
    const name = required(record, source.fieldMap, 'name', 'product name', 160);
    if (name.length < 2)
      throw Errors.validation([{ field: 'name', message: 'must be at least 2 characters' }]);

    const categoryCode = text(mapped(record, source.fieldMap, 'categoryCode'), 32);
    const category = categoryCode ? context.categoryByCode.get(categoryCode.toLowerCase()) : null;
    if (categoryCode && (!category || !category.isActive))
      throw Errors.validation([{ field: 'categoryCode', message: 'is not an active category' }]);

    const karat = number(mapped(record, source.fieldMap, 'karat'));
    const baseWeightGram = number(mapped(record, source.fieldMap, 'baseWeightGram'));
    if (karat !== undefined && (karat < 0.1 || karat > 24))
      throw Errors.validation([{ field: 'karat', message: 'must be between 0.1 and 24' }]);
    if (baseWeightGram !== undefined && baseWeightGram <= 0)
      throw Errors.validation([{ field: 'baseWeightGram', message: 'must be positive' }]);
    const rawBullion = mapped(record, source.fieldMap, 'isBullion');
    const isBullion = boolean(rawBullion);
    if (rawBullion !== undefined && isBullion === undefined)
      throw Errors.validation([{ field: 'isBullion', message: 'must be a boolean' }]);

    const product = await masterdata.products.create(actor, {
      sku,
      name,
      categoryId: category?.id,
      karat,
      baseWeightGram,
      isBullion,
    });
    context.productBySku.set(sku.toLowerCase(), product);
    return { status: 'created' };
  }

  async function importLead(source, record, actor, context) {
    const fullName = required(record, source.fieldMap, 'fullName', 'name', 120);
    if (fullName.length < 2)
      throw Errors.validation([{ field: 'fullName', message: 'must be at least 2 characters' }]);
    const rawPhone = required(record, source.fieldMap, 'phone', 'phone', 40);
    const phone = normalizeIndonesianPhone(rawPhone);
    if (!phone)
      throw Errors.validation([{ field: 'phone', message: 'is not a valid Indonesian number' }]);
    const email = text(mapped(record, source.fieldMap, 'email'), 160)?.toLowerCase() ?? null;
    if (email && !EMAIL_PATTERN.test(email))
      throw Errors.validation([{ field: 'email', message: 'is not a valid email address' }]);

    const phoneHash = blindIndex('phone', phone);
    if (
      (await uow.repos.customers.findIdByPhoneHash(phoneHash)) ||
      (await uow.repos.leads.findActiveIdByPhoneHash(phoneHash))
    )
      return { status: 'matched' };

    const referenceCode = text(mapped(record, source.fieldMap, 'referenceCode'), 32);
    const reference = referenceCode
      ? context.referenceByCode.get(referenceCode.toLowerCase())
      : null;
    if (referenceCode && (!reference || !reference.isActive))
      throw Errors.validation([{ field: 'referenceCode', message: 'is not an active channel' }]);
    const branchCode = text(mapped(record, source.fieldMap, 'branchCode'), 32);
    const branch = branchCode
      ? context.branches.find((item) => item.code.toLowerCase() === branchCode.toLowerCase())
      : null;
    if (branchCode && !branch)
      throw Errors.validation([{ field: 'branchCode', message: 'is not an active outlet' }]);
    const areaCode = text(mapped(record, source.fieldMap, 'areaCode'), 32);
    const area = areaCode ? context.areaByCode.get(areaCode.toLowerCase()) : null;
    if (areaCode && (!area || !area.isActive))
      throw Errors.validation([{ field: 'areaCode', message: 'is not an active area' }]);

    try {
      await leads.create(actor, {
        fullName,
        phone,
        email,
        referenceId: reference?.id,
        branchId: branch?.id,
        areaId: area?.id,
        notes: text(mapped(record, source.fieldMap, 'notes'), 500),
      });
      return { status: 'created' };
    } catch (error) {
      if (
        error.status === 409 &&
        /already (an open lead|a registered customer)/i.test(error.message)
      )
        return { status: 'matched' };
      throw error;
    }
  }

  async function importAppointment(source, record, actor, context) {
    const externalId = validKey(record, source.fieldMap);
    const key = keyHash(blindIndex, source, externalId);
    const branch = branchFor(record, source.fieldMap, context.branches);
    const customerId = await customerIdFor(source, record, source.fieldMap, uow, blindIndex);
    if (!customerId)
      throw Errors.validation([
        {
          field: 'customerAccountId|customerPhone',
          message: 'does not match an existing customer',
        },
      ]);
    const serviceType = required(
      record,
      source.fieldMap,
      'serviceType',
      'service type',
      16,
    ).toUpperCase();
    if (!SERVICE_TYPES.has(serviceType))
      throw Errors.validation([{ field: 'serviceType', message: 'is not supported' }]);
    const scheduledAt = new Date(getPath(record, source.fieldMap.scheduledAt));
    if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt <= new Date())
      throw Errors.validation([
        { field: 'scheduledAt', message: 'must be a future date and time' },
      ]);

    const result = await appointments.create(
      actor,
      {
        customerId,
        branchId: branch.id,
        serviceType,
        scheduledAt,
        notes: text(mapped(record, source.fieldMap, 'notes'), 500),
      },
      { sourceId: source.id, keyHash: key },
    );
    return { status: result.created ? 'created' : 'matched' };
  }

  async function importTransaction(source, record, actor, context) {
    const externalId = validKey(record, source.fieldMap);
    const key = keyHash(blindIndex, source, externalId);
    const branch = branchFor(record, source.fieldMap, context.branches);
    const customerId = await customerIdFor(source, record, source.fieldMap, uow, blindIndex);
    if (!customerId)
      throw Errors.validation([
        {
          field: 'customerAccountId|customerPhone',
          message: 'does not match an existing customer',
        },
      ]);
    const typeCode = required(
      record,
      source.fieldMap,
      'transactionTypeCode',
      'transaction type',
      32,
    );
    const transactionType = context.typeByCode.get(typeCode.toLowerCase());
    if (!transactionType?.isActive)
      throw Errors.validation([
        { field: 'transactionTypeCode', message: 'is not an active transaction type' },
      ]);
    const rawItems = getPath(record, source.fieldMap.items);
    if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > MAX_TRANSACTION_ITEMS)
      throw Errors.validation([
        { field: 'items', message: `must be a list of 1–${MAX_TRANSACTION_ITEMS} items` },
      ]);

    const items = rawItems.map((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw Errors.validation([{ field: `items[${index}]`, message: 'must be an object' }]);
      const description = text(getPath(raw, source.fieldMap.itemDescription), 200);
      const weightGram = number(getPath(raw, source.fieldMap.itemWeightGram));
      const unitPrice = number(getPath(raw, source.fieldMap.itemUnitPrice));
      if (!description)
        throw Errors.validation([{ field: `items[${index}].description`, message: 'is required' }]);
      if (!(weightGram > 0))
        throw Errors.validation([
          { field: `items[${index}].weightGram`, message: 'must be positive' },
        ]);
      if (!(unitPrice >= 0))
        throw Errors.validation([
          { field: `items[${index}].unitPrice`, message: 'must be zero or positive' },
        ]);
      const rawSku = text(mapped(raw, source.fieldMap, 'itemProductSku'), 64);
      const product = rawSku ? context.productBySku.get(rawSku.toLowerCase()) : null;
      if (rawSku && !product)
        throw Errors.validation([
          { field: `items[${index}].productSku`, message: 'is not an active product' },
        ]);
      const karat = number(mapped(raw, source.fieldMap, 'itemKarat'));
      if (karat !== undefined && (karat <= 0 || karat > 24))
        throw Errors.validation([
          { field: `items[${index}].karat`, message: 'must be between 0 and 24' },
        ]);
      return { description, weightGram, unitPrice, productId: product?.id, karat };
    });
    const occurredValue = mapped(record, source.fieldMap, 'occurredAt');
    const occurredAt = occurredValue ? new Date(occurredValue) : undefined;
    if (occurredAt && !Number.isFinite(occurredAt.getTime()))
      throw Errors.validation([{ field: 'occurredAt', message: 'is not a valid date and time' }]);

    const result = await transactions.record(
      actor,
      {
        customerId,
        transactionTypeId: transactionType.id,
        branchId: branch.id,
        invoiceNo: text(mapped(record, source.fieldMap, 'invoiceNo'), 40),
        description: text(mapped(record, source.fieldMap, 'description'), 200),
        occurredAt,
        items,
      },
      { sourceId: source.id, keyHash: key },
    );
    return { status: result.created ? 'created' : 'matched' };
  }

  async function importDataset(source, record) {
    const externalId = validKey(record, source.fieldMap);
    if (record === null || typeof record !== 'object' || Array.isArray(record))
      throw Errors.validation([{ field: 'record', message: 'must be a JSON object' }]);
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > MAX_DATASET_RECORD_BYTES)
      throw Errors.validation([{ field: 'record', message: 'exceeds the 100 KB record limit' }]);
    const inserted = await uow.repos.integrations.upsertDatasetRecord(
      source.id,
      keyHash(blindIndex, source, externalId),
      pii.encrypt(json, `integrations.dataset:${source.id}`),
    );
    return { status: inserted ? 'created' : 'matched' };
  }

  async function importRecord(source, record, actor, context) {
    if (source.targetType === 'CUSTOMER') return importCustomer({ ...source, actor }, record);
    if (source.targetType === 'PRODUCT') return importProduct(source, record, actor, context);
    if (source.targetType === 'LEAD') return importLead(source, record, actor, context);
    if (source.targetType === 'APPOINTMENT')
      return importAppointment(source, record, actor, context);
    if (source.targetType === 'TRANSACTION')
      return importTransaction(source, record, actor, context);
    if (source.targetType === 'DATASET') return importDataset(source, record);
    throw Errors.validation([{ field: 'targetType', message: 'is not supported' }]);
  }

  function recordList(payload, listPath) {
    return extractList(payload, listPath);
  }

  return Object.freeze({ prepare, importRecord, recordList });
}
