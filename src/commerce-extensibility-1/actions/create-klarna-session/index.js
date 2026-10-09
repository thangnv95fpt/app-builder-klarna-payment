import { randomBytes } from "node:crypto";

import { unwrapHttpError } from "@adobe/aio-commerce-lib-api/utils";
import { getCommerceInstance } from "@adobe/aio-commerce-lib-app";
import {
  getInstrumentationHelpers,
  instrumentEntrypoint,
} from "@adobe/aio-lib-telemetry";
import { GraphQLClient } from "graphql-request";

import { telemetryConfig } from "../telemetry.js";
import { CartNotFoundError, fetchCart, setPaymentMethodOnCart } from "../commerce/cart.js";
import {
  generateCreateSessionRequest,
  KlarnaRequestError,
} from "../klarna/request.js";

import { createKlarnaSession } from "../klarna/client.js";
import { KlarnaDb } from "../klarna/db.js";
const MASK_CART_ID_PATTERN = /^[A-Za-z0-9]+$/;


const TRAILING_SLASHES = /\/+$/;
const isTrue = (value) => value === true || value === "true" || value === "1";
const trimTrailingSlash = (value) =>
  String(value ?? "").replace(TRAILING_SLASHES, "");
const response = (statusCode, body) => ({ body, statusCode });

/**
 * Creates the Adobe Commerce HTTP client from the IMS credentials in the action inputs. The base URL comes from the
 * app association. The client targets `rest/<store>/V1`, so it is re-pointed to the root where `/graphql` lives.
 */
async function createCommerceGraphqlClient() {
  const commerceInstance = await getCommerceInstance();
  const baseUrl = `${commerceInstance.baseUrl}/graphql`;

  return new GraphQLClient(baseUrl);
}

function getMissingConfiguration(params) {
  return [
    "AIO_COMMERCE_API_BASE_URL",
    "STOREFRONT_URL",
    "KLARNA_MERCHANT_ID",
    "KLARNA_SHARED_SECRET",
  ].filter((key) => !params[key]);
}

/**
 * Creates a Klarna Payments session for a Magento guest cart.
 *
 * Required input: `maskCartID`, the masked ID of the Magento (guest) cart.
 * Optional input: `storeCode`, `locale`, `authCallbackToken`.
 *
 * @param {object} params the input parameters
 * @returns {Promise<{statusCode: number, body: object}>} the response object
 */
async function createKlarnaSessionAction(params) {
  const { logger } = getInstrumentationHelpers();
  const { maskCartID } = params;

  if (
    typeof maskCartID !== "string" ||
    !MASK_CART_ID_PATTERN.test(maskCartID)
  ) {
    return response(400, { error: "maskCartID is missing or invalid" });
  }

  // const missing = getMissingConfiguration(params);
  // if (missing.length > 0) {
  //   logger.error(`Missing action configuration: ${missing.join(", ")}`);
  //   return response(500, { error: "The action is not configured" });
  // }

  try {
    const commerceClient = await createCommerceGraphqlClient();
    const { cart, totals } = await fetchCart(
      commerceClient,
      maskCartID,
      params.storeCode,
    );

    // Klarna calls the authorization URL with this token, Magento has to know it for the quote to validate it.
    const authCallbackToken =
      params.authCallbackToken || maskCartID + '_' + randomBytes(32).toString("hex");

    const request = generateCreateSessionRequest({
      cart,
      config: {
        authCallbackToken,
        b2b: isTrue(params.KLARNA_B2B_ENABLED),
        defaultCountry: params.DEFAULT_COUNTRY,
        locale: params.locale,
        options: params.KLARNA_OPTIONS
          ? JSON.parse(params.KLARNA_OPTIONS)
          : undefined,
        prefillEnabled: isTrue(params.KLARNA_DATA_SHARING_ENABLED),
        storefrontUrl: trimTrailingSlash(params.STOREFRONT_URL),
        merchantUrls: {
          authorization: `https://webhook.site/7248e404-a998-4b0f-b4f0-fead3c1b54b6?token=${authCallbackToken}`,
        },
      },
      totals,
    });

    const session = await createKlarnaSession(params, request);
    logger.info(`Klarna session ${session.session_id} created`);
    const klarnaQuoteData = {
      authCallbackToken: authCallbackToken,
      sessionId: session.session_id,
      clientToken: session.client_token,
      paymentMethodCategories: session.payment_method_categories ?? [],
    }
    const db = await KlarnaDb.fromParams(params);
    await db.upsertQuote(maskCartID, klarnaQuoteData);
    await db.close();
    return response(200, klarnaQuoteData);  
  } catch (error) {
    logger.error(
      "Error creating the Klarna session:",
      error.response ? await unwrapHttpError(error) : error,
    );

    if (error instanceof KlarnaRequestError) {
      return response(422, { error: error.message });
    }
    if (error instanceof CartNotFoundError) {
      return response(404, { error: "Cart not found" });
    }
    return response(502, { error: "Unable to create the Klarna session" });
  }
}

export const main = instrumentEntrypoint(createKlarnaSessionAction, {
  ...telemetryConfig,
  isSuccessful: (result) => result.statusCode < 400,
});
