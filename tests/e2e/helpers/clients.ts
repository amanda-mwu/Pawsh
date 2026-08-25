import type { Locator, Page } from "@playwright/test";

/**
 * Client directory rows expose their actions through a per-row menu rather than
 * inline links, so tests must open the menu before the action is clickable.
 */
export async function openClientRowMenu(card: Locator): Promise<void> {
  await card.getByTestId("client-row-actions").click();
}

/** Click a client-level action (identified by test id) from the row menu. */
export async function clientAction(card: Locator, testId: string): Promise<void> {
  await openClientRowMenu(card);
  await card.getByTestId(testId).click();
}

/** Open a client's appointment history from the row menu. */
export async function openClientHistory(card: Locator): Promise<void> {
  await clientAction(card, "client-appointment-history");
}

/**
 * Click a per-pet action from the row menu. Pass `petId` to disambiguate a
 * client that owns more than one pet.
 */
export async function petAction(
  card: Locator,
  action: "profile" | "care" | "documents",
  petId?: string
): Promise<void> {
  await openClientRowMenu(card);
  await card.locator(petActionSelector(action, petId)).first().click();
}

/** Selector for a per-pet action, usable for presence/absence assertions. */
export function petActionSelector(
  action: "profile" | "care" | "documents",
  petId?: string
): string {
  return petId
    ? `[data-action-name="${action}"][data-id="${petId}"]`
    : `[data-action-name="${action}"]`;
}

/** Locate the client directory row that owns a given pet. */
export function cardForPet(page: Page, petId: string): Locator {
  return page.getByTestId("customer-card").filter({ has: page.locator(`[data-id="${petId}"]`) });
}
