/**
 * Builds the Klarna Payments "create session" request body from a Magento guest cart.
 *
 * Port of `Klarna\Kp\Model\Api\Builder\Request::generateCreateUpdateSessionRequest` (module-payments).
 * Amounts are sent to Klarna in minor units (cents), like `DataConverter::toApiFloat` does in PHP.
 */

const DIGITAL_PRODUCT_TYPES = new Set(["virtual", "downloadable", "giftcard"]);
const REQUIRED_ATTRIBUTES = [
  "purchase_country",
  "purchase_currency",
  "locale",
  "order_amount",
  "order_lines",
];

export class KlarnaRequestError extends Error {}

/** Converts a decimal amount to Klarna minor units. */
export const toMinorUnits = (amount) => Math.round(Number(amount ?? 0) * 100);

/** Reads the shipping address of a Magento cart (extension attributes). */
function getShippingAddress(cart) {
  return cart.extension_attributes?.shipping_assignments?.[0]?.shipping
    ?.address;
}

/** Same fallback chain as `PurchaseCountry::addToRequest`: billing, shipping, default. */
function resolvePurchaseCountry(cart, defaultCountry) {
  return (
    cart.billing_address?.country_id ||
    getShippingAddress(cart)?.country_id ||
    defaultCountry
  );
}

/** Port of `Addresses\Mapper::getKlarnaDataFromAddress`. */
function mapAddress(address, { b2b }) {
  const [street, street2] = address.street ?? [];
  const result = {
    city: address.city,
    country: address.country_id,
    email: address.email,
    family_name: address.lastname,
    given_name: address.firstname,
    phone: address.telephone,
    postal_code: address.postcode,
    region: address.region_code,
    street_address: street,
  };

  if (street2) {
    result.street_address2 = street2;
  }
  if (b2b) {
    result.organization_name = address.company;
  }
  return result;
}

function buildProductLine(item, cartItem, salesTax) {
  const discount = toMinorUnits(item.base_discount_amount);
  const rowTotal = toMinorUnits(
    salesTax ? item.base_row_total : item.base_row_total_incl_tax,
  );

  return {
    name: item.name,
    quantity: Number(item.qty),
    reference: cartItem.sku ?? String(item.item_id),
    tax_rate: salesTax ? 0 : Math.round(Number(item.tax_percent ?? 0) * 100),
    total_amount: rowTotal - discount,
    total_discount_amount: discount,
    total_tax_amount: salesTax ? 0 : toMinorUnits(item.base_tax_amount),
    type: DIGITAL_PRODUCT_TYPES.has(cartItem.product_type)
      ? "digital"
      : "physical",
    unit_price: toMinorUnits(
      salesTax ? item.base_price : item.base_price_incl_tax,
    ),
  };
}

function buildShippingLine(totals, salesTax) {
  const discount = toMinorUnits(totals.base_shipping_discount_amount);
  const shipping = toMinorUnits(
    salesTax ? totals.base_shipping_amount : totals.base_shipping_incl_tax,
  );
  const tax = toMinorUnits(totals.base_shipping_tax_amount);
  const taxRate =
    salesTax || shipping === tax
      ? 0
      : Math.round((tax / (shipping - tax)) * 10_000);

  return {
    name: "Shipping",
    quantity: 1,
    reference: "shipping",
    tax_rate: taxRate,
    total_amount: shipping - discount,
    total_discount_amount: discount,
    total_tax_amount: salesTax ? 0 : tax,
    type: "shipping_fee",
    unit_price: shipping,
  };
}

function buildSalesTaxLine(totals) {
  const tax = toMinorUnits(totals.base_tax_amount);

  return {
    name: "Sales Tax",
    quantity: 1,
    reference: "sales_tax",
    tax_rate: 0,
    total_amount: tax,
    total_tax_amount: 0,
    type: "sales_tax",
    unit_price: tax,
  };
}

/**
 * Builds the order lines. When `salesTax` is true (US market: prices exclude tax) a single `sales_tax`
 * line carries the whole tax amount, otherwise taxes are included in every line.
 */
function buildOrderLines(cart, totals, salesTax) {
  const cartItems = new Map(
    (cart.items ?? []).map((item) => [item.item_id, item]),
  );
  const lines = (totals.items ?? []).map((item) =>
    buildProductLine(item, cartItems.get(item.item_id) ?? {}, salesTax),
  );

  if (!cart.is_virtual && totals.base_shipping_amount !== undefined) {
    lines.push(buildShippingLine(totals, salesTax));
  }
  if (salesTax) {
    lines.push(buildSalesTaxLine(totals));
  }
  return lines;
}

/** Port of `OrderTaxAmount::addToRequest`. */
function computeOrderTaxAmount(orderLines) {
  let taxAmount = 0;
  for (const line of orderLines) {
    if (line.type === "sales_tax") {
      return line.total_amount;
    }
    taxAmount += line.total_tax_amount;
  }
  return taxAmount;
}

/**
 * Generates the create session request.
 *
 * @param {object} args
 * @param {object} args.cart Response of `GET /V1/guest-carts/:maskId`
 * @param {object} args.totals Response of `GET /V1/guest-carts/:maskId/totals`
 * @param {object} args.config Klarna/store configuration (see the action for the supported keys)
 * @returns {object} the Klarna request body
 * @throws {KlarnaRequestError} when a required attribute is missing or the order lines do not match the order amount
 */
export function generateCreateSessionRequest({ cart, totals, config }) {
  const purchaseCountry = resolvePurchaseCountry(cart, config.defaultCountry);
  const salesTax = purchaseCountry === "US";
  const orderLines = buildOrderLines(cart, totals, salesTax);
  const billingAddress = cart.billing_address;

  const request = {
    acquiring_channel: "ECOMMERCE",
    customer: { type: config.b2b ? "organization" : "person" },
    locale: config.locale || `en-${purchaseCountry}`,
    order_amount: toMinorUnits(totals.base_grand_total),
    order_lines: orderLines,
    order_tax_amount: computeOrderTaxAmount(orderLines),
    purchase_country: purchaseCountry,
    purchase_currency: cart.currency?.base_currency_code,
  };

  if (config.options) {
    request.options = config.options;
  }

  // Prefill is only allowed for US customers that agreed to the data sharing (`Customer\Generator::isPrefillAllowed`).
  if (config.prefillEnabled && billingAddress?.country_id === "US") {
    request.billing_address = mapAddress(billingAddress, config);
    if (!cart.is_virtual && getShippingAddress(cart)) {
      request.shipping_address = mapAddress(getShippingAddress(cart), config);
    }
  }

  const missing = REQUIRED_ATTRIBUTES.filter((key) => {
    const value = request[key];
    return value === undefined || value === null || value === "";
  });
  if (missing.length > 0 || orderLines.length === 0) {
    throw new KlarnaRequestError(
      `Required attributes are missing: ${missing.join(", ") || "order_lines"}`,
    );
  }

  const linesTotal = orderLines.reduce(
    (sum, line) => sum + line.total_amount,
    0,
  );
  if (linesTotal !== request.order_amount) {
    throw new KlarnaRequestError(
      `Order line totals do not total order_amount - ${linesTotal} != ${request.order_amount}`,
    );
  }

  return request;
}
