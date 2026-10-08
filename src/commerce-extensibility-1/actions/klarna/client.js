const KLARNA_API_VERSION = "v1";

const KLARNA_URLS = {
  eu: {
    production: "https://api.klarna.com",
    test: "https://api.playground.klarna.com",
  },
  na: {
    production: "https://api-na.klarna.com",
    test: "https://api-na.playground.klarna.com",
  },
  oc: {
    production: "https://api-oc.klarna.com",
    test: "https://api-oc.playground.klarna.com",
  },
};

/** Port of `Payments::createSession`: POST /payments/v1/sessions authenticated with the merchant credentials. */
export async function createKlarnaSession(params, request) {
  const region = (params.KLARNA_REGION || "na").toLowerCase();
  const mode = params.KLARNA_PRODUCTION_MODE === true || params.KLARNA_PRODUCTION_MODE === "true" || params.KLARNA_PRODUCTION_MODE === "1" ? "production" : "test";
  const baseUrl = KLARNA_URLS[region]?.[mode];
  if (!baseUrl) {
    throw new Error(`Unsupported KLARNA_REGION "${region}"`);
  }

  const credentials = Buffer.from(
    `${params.KLARNA_MERCHANT_ID}:${params.KLARNA_SHARED_SECRET}`,
  ).toString("base64");
  const result = await fetch(
    `${baseUrl}/payments/${KLARNA_API_VERSION}/sessions`,
    {
      body: JSON.stringify(request),
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );

  const body = await result.json().catch(() => ({}));
  if (!result.ok) {
    const error = new Error(
      `Klarna request failed (${result.status}): ${(body.error_messages ?? []).join("; ")}`,
    );
    error.status = result.status;
    throw error;
  }
  return body;
}
