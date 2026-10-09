import { getCommerceInstance } from "@adobe/aio-commerce-lib-app";
import {
  getInstrumentationHelpers,
  instrumentEntrypoint,
} from "@adobe/aio-lib-telemetry";
import { GraphQLClient } from "graphql-request";

import { CartNotFoundError, fetchCart, setCustomAttributesOnCart } from "../commerce/cart.js";
import { AUTH_CALLBACK_STATUS, KlarnaDb } from "../klarna/db.js";
import { telemetryConfig } from "../telemetry.js";

const response = (statusCode, body) => ({ body, statusCode });

class CallbackError extends Error {}

/**
 * Port of `Klarna\Kp\Controller\Klarna\Authorize`: the Klarna authorization callback.
 *
 * Klarna POSTs `{ session_id, authorization_token }` to `<action-url>?token=<authCallbackToken>`.
 * The Klarna quote is read from the `klarna_quote` collection and the Magento cart through Commerce GraphQL.
 * Optional input: `storeCode`, `dryRun`.
 *
 * @param {object} params the input parameters
 * @returns {Promise<{statusCode: number, body?: object}>}
 */
async function authorizeAction(params) {
  const { logger } = getInstrumentationHelpers();

  if (params.dryRun) {
    return response(200, {
      code: 200,
      message: "The authorize action is accessible.",
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  const sessionId = params.session_id;
  let db;
  let klarnaQuote;
  let claimed = false;

  try {
    // RequestValidator::validateRequestBody
    for (const name of ["session_id", "authorization_token"]) {
      if (!params[name]) {
        throw new CallbackError(`${name} is required.`);
      }
    }
    logger.debug(`Authorization callback for session ID: ${sessionId}.`);

    db = await KlarnaDb.fromParams(params);
    klarnaQuote = await db.getQuoteBySessionId(sessionId);
    if (!klarnaQuote) {
      throw new CallbackError(`Klarna quote not found for session ${sessionId}.`);
    }

    const ow_query = params.__ow_query;
    // RequestValidator::verifyAuthCallbackToken
    if (!ow_query.token || ow_query.token !== klarnaQuote.authCallbackToken) {
      throw new CallbackError('Invalid value provided for the token field.');
    }

    // RequestValidator::verifyMagentoQuote: GraphQL only resolves active carts.
    const commerceInstance = await getCommerceInstance();
    const commerceClient = new GraphQLClient(`${commerceInstance.baseUrl}/graphql`);
    await fetchCart(commerceClient, klarnaQuote.id, params.storeCode, false);

    claimed = await db.claimAuthCallback(klarnaQuote.id, params.authorization_token);
    if (!claimed) {
      return response(400, {
        error: "Another authorization callback workflow is still in progress.",
      });
    }

    await setCustomAttributesOnCart(
      commerceClient,
      klarnaQuote.id,
      [{ attribute_code: "klarna_authorize_token", value: params.authorization_token }],
      params.storeCode,
    );

    await db.setAuthCallbackStatus(klarnaQuote.id, AUTH_CALLBACK_STATUS.SUCCESSFUL);
    return response(200);
  } catch (error) {
    logger.error(`Authorization callback failed for session ${sessionId}:`, error);

    if (claimed) {
      await db.setAuthCallbackStatus(klarnaQuote.id, AUTH_CALLBACK_STATUS.FAILED);
    }
    if (error instanceof CartNotFoundError) {
      return response(400, { error: "The cart is not active." });
    }
    if (error instanceof CallbackError) {
      return response(400, { error: error.message });
    }
    return response(400, { error: error.message ?? "Unable to place the order" });
  } finally {
    await db?.close();
  }
  
}

export const main = instrumentEntrypoint(authorizeAction, {
  ...telemetryConfig,
  isSuccessful: (result) => result.statusCode < 400,
});
