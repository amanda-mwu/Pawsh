import type { Config } from "../../config.js";
import { IntegrationKeyring } from "../../security/integration-encryption.js";
import type { SquareEnvironment } from "./client.js";

/**
 * Whether Square is available to this deployment, and why not when it is not.
 *
 * No Square credentials exist for this project yet, so "unconfigured" is the normal state and
 * has to be a first-class answer rather than a crash or - worse - a screen that offers a connect
 * button leading nowhere. Every route in the integration asks this first and reports the reason
 * it gets back, so what an operator sees is the actual missing variable rather than a 500 or a
 * silent absence. This is the same discipline `cardProcessing.connectable` already applies on
 * the settings read: the server says what it can do, and the client is not left to infer it.
 */

export interface SquareIntegrationSettings {
  environment: SquareEnvironment;
  applicationId: string;
  applicationSecret: string;
  /** The exact configured string Square signs against. Never derived from a request header. */
  notificationUrl: string;
  webhookSignatureKey: string;
  redirectUri: string;
  keyring: IntegrationKeyring;
}

export type SquareAvailability =
  | { available: true; settings: SquareIntegrationSettings }
  | { available: false; reason: string };

export const squareUnavailableCode = "SQUARE_NOT_CONFIGURED";

/** Where Square sends the merchant's browser back to. Must match the application's dashboard. */
export function squareRedirectUri(config: Pick<Config, "APP_ORIGIN">): string {
  return `${config.APP_ORIGIN}/api/integrations/square/callback`;
}

export function squareIntegration(config: Config): SquareAvailability {
  if (!config.PAWSH_INTEGRATION_ENCRYPTION_KEYS || !config.PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE) {
    return {
      available: false,
      reason: "PAWSH_INTEGRATION_ENCRYPTION_KEYS is not configured, so Square credentials have "
        + "nowhere sealed to live."
    };
  }
  const missing = ([
    ["PAWSH_SQUARE_APPLICATION_ID", config.PAWSH_SQUARE_APPLICATION_ID],
    ["PAWSH_SQUARE_APPLICATION_SECRET", config.PAWSH_SQUARE_APPLICATION_SECRET],
    ["PAWSH_SQUARE_ENVIRONMENT", config.PAWSH_SQUARE_ENVIRONMENT],
    ["PAWSH_SQUARE_NOTIFICATION_URL", config.PAWSH_SQUARE_NOTIFICATION_URL],
    ["PAWSH_SQUARE_WEBHOOK_SIGNATURE_KEY", config.PAWSH_SQUARE_WEBHOOK_SIGNATURE_KEY]
  ] as const).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    return { available: false, reason: `Square is not configured: ${missing.join(", ")} is unset.` };
  }
  return {
    available: true,
    settings: {
      environment: config.PAWSH_SQUARE_ENVIRONMENT!,
      applicationId: config.PAWSH_SQUARE_APPLICATION_ID!,
      applicationSecret: config.PAWSH_SQUARE_APPLICATION_SECRET!,
      notificationUrl: config.PAWSH_SQUARE_NOTIFICATION_URL!,
      webhookSignatureKey: config.PAWSH_SQUARE_WEBHOOK_SIGNATURE_KEY!,
      redirectUri: squareRedirectUri(config),
      keyring: IntegrationKeyring.parse(
        config.PAWSH_INTEGRATION_ENCRYPTION_KEYS,
        config.PAWSH_INTEGRATION_ENCRYPTION_KEY_ACTIVE
      )
    }
  };
}
