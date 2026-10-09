/**
 * Reads a guest cart through the Commerce GraphQL API and adapts it to the cart/totals shape that
 * `klarna-request.js` consumes (the same fields the REST guest-carts endpoints return).
 *
 * GraphQL only exposes the amounts in the cart (display) currency, so they are used as the Klarna amounts.
 */

const ADDRESS_FIELDS = `
  city
  company
  country { code }
  firstname
  lastname
  postcode
  region { code }
  street
  telephone
`;

/**
 * Fields follow the Adobe Commerce as a Cloud Service (SaaS) GraphQL schema: the items are exposed by `itemsV2`
 * and identified by `uid`.
 * @see https://developer.adobe.com/commerce/webapi/reference/graphql/saas/#cart
 */
export const GET_CART_QUERY = `
  query GetCart($maskCartID: String!) {
    cart(cart_id: $maskCartID) {
      id
      email
      is_virtual
      billing_address { ${ADDRESS_FIELDS} }
      shipping_addresses {
        ${ADDRESS_FIELDS}
        selected_shipping_method {
          amount { value }
          price_excl_tax { value }
          price_incl_tax { value }
        }
      }
      itemsV2 {
        items {
          __typename
          uid
          quantity
          product { name sku }
          prices {
            price { value }
            price_including_tax { value }
            row_total { value }
            row_total_including_tax { value }
            total_item_discount { value }
          }
        }
      }
      prices {
        grand_total { value currency }
        applied_taxes { label amount { value } }
      }
    }
  }
`;

export class CartNotFoundError extends Error {}

const sum = (values) => values.reduce((total, value) => total + value, 0);

function mapAddress(address, email) {
  if (!address) {
    return;
  }

  return {
    city: address.city,
    company: address.company,
    country_id: address.country?.code,
    email,
    firstname: address.firstname,
    lastname: address.lastname,
    postcode: address.postcode,
    region_code: address.region?.code,
    street: address.street,
    telephone: address.telephone,
  };
}

function mapItem(item) {
  const rowTotal = item.prices.row_total.value;
  const rowTotalInclTax = item.prices.row_total_including_tax.value;

  return {
    base_discount_amount: item.prices.total_item_discount?.value ?? 0,
    base_price: item.prices.price.value,
    base_price_incl_tax: item.prices.price_including_tax.value,
    base_row_total: rowTotal,
    base_row_total_incl_tax: rowTotalInclTax,
    base_tax_amount: rowTotalInclTax - rowTotal,
    item_id: item.uid,
    name: item.product.name,
    qty: item.quantity,
    tax_percent:
      rowTotal === 0
        ? 0
        : Math.round(((rowTotalInclTax - rowTotal) / rowTotal) * 10_000) / 100,
  };
}

/** Totals of the shipping method. Not set for virtual carts or when no method is selected yet. */
function mapShipping(shippingAddress) {
  const method = shippingAddress?.selected_shipping_method;
  if (!method) {
    return {};
  }

  const excludingTax = method.price_excl_tax?.value ?? method.amount.value;
  const includingTax = method.price_incl_tax?.value ?? excludingTax;
  return {
    base_shipping_amount: excludingTax,
    base_shipping_discount_amount: 0,
    base_shipping_incl_tax: includingTax,
    base_shipping_tax_amount: includingTax - excludingTax,
  };
}

/**
 * Converts the GraphQL cart into the `{ cart, totals }` inputs of `generateCreateSessionRequest`.
 *
 * @param {object} gqlCart the `cart` node of the {@link GET_CART_QUERY} response
 * @returns {{cart: object, totals: object}}
 */
export function toKlarnaCart(gqlCart) {
  const shippingAddress = gqlCart.shipping_addresses?.[0];
  const items = gqlCart.itemsV2?.items ?? [];
  const { grand_total: grandTotal, applied_taxes: appliedTaxes } =
    gqlCart.prices;

  return {
    cart: {
      billing_address: mapAddress(gqlCart.billing_address, gqlCart.email),
      currency: { base_currency_code: grandTotal.currency },
      extension_attributes: {
        shipping_assignments: [
          {
            shipping: {
              address: mapAddress(shippingAddress, gqlCart.email),
            },
          },
        ],
      },
      is_virtual: gqlCart.is_virtual,
      items: items.map((item) => ({
        item_id: item.uid,
        // e.g. `VirtualCartItem` -> `virtual`
        product_type: item.__typename.replace("CartItem", "").toLowerCase(),
        sku: item.product.sku,
      })),
    },
    totals: {
      ...mapShipping(shippingAddress),
      base_grand_total: grandTotal.value,
      base_tax_amount: sum((appliedTaxes ?? []).map((tax) => tax.amount.value)),
      items: items.map(mapItem),
    },
  };
}

/** `graphql-request` rejects with a `ClientError` that carries the GraphQL errors in `response.errors`. */
function getGraphqlErrors(error) {
  return error?.response?.errors ?? [];
}

/**
 * Fetches the cart of the given mask ID.
 *
 * @param {import("graphql-request").GraphQLClient} graphqlClient client targeting the Commerce GraphQL endpoint
 * @param {string} maskCartID the masked ID of the cart
 * @param {string} [storeCode] store view code, sent as the `Store` header
 * @returns {Promise<{cart: object, totals: object}>}
 * @throws {CartNotFoundError} when Commerce does not know the cart
 */
export async function fetchCart(graphqlClient, maskCartID, storeCode, convertToKlarnaCart = true) {
  let data;
  try {
    data = await graphqlClient.request(
      GET_CART_QUERY,
      { maskCartID },
      storeCode ? { Store: storeCode } : undefined,
    );
  } catch (error) {
    const errors = getGraphqlErrors(error);
    if (
      errors.some(
        (graphqlError) =>
          graphqlError.extensions?.category === "graphql-no-such-entity",
      )
    ) {
      throw new CartNotFoundError(errors[0].message, { cause: error });
    }
    throw error;
  }

  if (!data?.cart) {
    throw new CartNotFoundError("Cart not found");
  }

  return convertToKlarnaCart ? toKlarnaCart(data.cart) : { cart: data.cart};
}


export async function setPaymentMethodOnCart(graphqlClient, maskCartID, paymentMethod, storeCode) {
  const mutation = `
    mutation SetPaymentMethodOnCart($maskCartID: String!, $paymentMethod: PaymentMethodInput!) {
      setPaymentMethodOnCart(input: { cart_id: $maskCartID, payment_method: $paymentMethod }) {
        cart {
          id
        }
      }
    }
  `;

  try {
    await graphqlClient.request(
      mutation,
      { maskCartID, paymentMethod },
      storeCode ? { Store: storeCode } : undefined,
    );
  } catch (error) {
    const errors = getGraphqlErrors(error);
    if (
      errors.some(
        (graphqlError) =>
          graphqlError.extensions?.category === "graphql-no-such-entity",
      )
    ) {
      throw new CartNotFoundError(errors[0].message, { cause: error });
    }
    throw error;
  }
}

/**
 * Sets custom attributes on the cart, keeping the ones already on it.
 *
 * The mutation replaces the attributes it is given, so the current ones are read first and merged with
 * `customAttributes` (an entry with an existing `attribute_code` overrides the current value).
 *
 * @see https://developer.adobe.com/commerce/webapi/reference/graphql/saas/mutations#setcustomattributesoncart
 * @param {import("graphql-request").GraphQLClient} graphqlClient client targeting the Commerce GraphQL endpoint
 * @param {string} maskCartID the masked ID of the cart
 * @param {{attribute_code: string, value: string}[]} customAttributes the `CustomAttributeInput` entries to set
 * @param {string} [storeCode] store view code, sent as the `Store` header
 * @throws {CartNotFoundError} when Commerce does not know the cart
 */
export async function setCustomAttributesOnCart(graphqlClient, maskCartID, customAttributes, storeCode) {
  const query = `
    query GetCartCustomAttributes($maskCartID: String!) {
      cart(cart_id: $maskCartID) {
        custom_attributes { attribute_code value }
      }
    }
  `;
  const mutation = `
    mutation SetCustomAttributesOnCart($input: CartCustomAttributesInput!) {
      setCustomAttributesOnCart(input: $input) {
        cart {
          id
        }
      }
    }
  `;
  const headers = storeCode ? { Store: storeCode } : undefined;

  try {
    const data = await graphqlClient.request(query, { maskCartID }, headers);
    if (!data?.cart) {
      throw new CartNotFoundError("Cart not found");
    }

    const merged = new Map(
      (data.cart.custom_attributes ?? []).map(({ attribute_code, value }) => [
        attribute_code,
        { attribute_code, value },
      ]),
    );
    for (const { attribute_code, value } of customAttributes) {
      merged.set(attribute_code, { attribute_code, value });
    }

    await graphqlClient.request(
      mutation,
      { input: { cart_id: maskCartID, custom_attributes: [...merged.values()] } },
      headers,
    );
  } catch (error) {
    const errors = getGraphqlErrors(error);
    if (
      errors.some(
        (graphqlError) =>
          graphqlError.extensions?.category === "graphql-no-such-entity",
      )
    ) {
      throw new CartNotFoundError(errors[0].message, { cause: error });
    }
    throw error;
  }
}

/** Places the order of the (guest) cart. Returns the order number. */
export async function placeOrder(graphqlClient, maskCartID, storeCode) {
  const mutation = `
    mutation PlaceOrder($maskCartID: String!) {
      placeOrder(input: { cart_id: $maskCartID }) {
        errors { code message }
        orderV2 { number }
      }
    }
  `;

  const data = await graphqlClient.request(
    mutation,
    { maskCartID },
    storeCode ? { Store: storeCode } : undefined,
  );
  const { errors, orderV2 } = data.placeOrder;
  if (errors?.length) {
    throw new PlaceOrderError(errors.map((error) => error.message).join("; "));
  }
  return orderV2?.number;
}

export class PlaceOrderError extends Error {}
