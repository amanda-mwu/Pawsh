/**
 * Push notification boundary.
 *
 * **Nothing here talks to a notification service, and that is deliberate.** The backend has no
 * device-token table and no endpoint to register one, so an app that acquired a push token today
 * would have nowhere to send it. Wiring `expo-notifications` anyway would ship a permission
 * prompt that buys the groomer nothing and trains them to decline the one that will matter.
 *
 * What exists is the shape of the integration, so that adding it later is a change in one file:
 *
 *  1. Backend adds `POST /api/me/devices` accepting `{ token, platform }`, scoped to the session,
 *     and a `device_tokens` table keyed by `(business_id, membership_id, token)` with a
 *     `revoked_at`. Registration must be idempotent — a token is re-presented on every launch.
 *  2. `registerDevice()` below gains its body: request permission, read the Expo push token, and
 *     `POST` it. Call it once from the root layout **after** a successful sign-in, never before —
 *     a token registered against no session cannot be routed to a person.
 *  3. `unregisterDevice()` is called from sign-out, before the token is cleared, so the server can
 *     stop sending to a phone that has been handed to somebody else.
 *
 * Until step 1 exists these are no-ops that report why.
 */

export type DevicePlatform = "ios" | "android";

export interface DeviceRegistration {
  token: string;
  platform: DevicePlatform;
}

export type RegistrationOutcome =
  | { status: "registered"; registration: DeviceRegistration }
  | { status: "unsupported"; reason: string };

const NOT_YET_AVAILABLE =
  "Push delivery is not wired: the API has no device-token registration endpoint.";

/** The single point a device token would be acquired and sent. */
export async function registerDevice(): Promise<RegistrationOutcome> {
  return { status: "unsupported", reason: NOT_YET_AVAILABLE };
}

/** The single point a device token would be revoked, called before the session is cleared. */
export async function unregisterDevice(): Promise<RegistrationOutcome> {
  return { status: "unsupported", reason: NOT_YET_AVAILABLE };
}

export const pushDeliveryAvailable = false;
