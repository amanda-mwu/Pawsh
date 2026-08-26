import { describe, expect, it } from "vitest";
import {
  appointmentStatuses, appointmentStatusBadges, appointmentStatusLabel,
  formatMinor, invoiceStatuses, invoiceStatusLabels, invoiceOutstandingStatuses,
  paymentMethods, paymentMethodLabels, paymentStatuses, paymentStatusLabels,
  permissionLabels, permissions, petHealthIssueLabels, petHealthIssues,
  poundsFromOunces, pricingClasses, pricingClassLabels, pricingModes, pricingModeLabels,
  rabiesAppointmentStatusLabels, rabiesNeedsAttention, rabiesVerificationStatusLabels,
  rabiesVerificationStatuses, serviceCategories, serviceCategoryLabels
} from "@pawsh/domain";

/**
 * The label tables are typed as total Records, so an unlabelled value is already a build error.
 * These tests cover what the type system cannot: that no table carries a key the domain does not
 * define. That is the failure that actually happened — `public/app.js` shipped a rabies label for
 * `unverified`, a value no appointment can ever hold.
 */
function expectExactKeys(table: Record<string, unknown>, expected: readonly string[]): void {
  expect(Object.keys(table).sort()).toEqual([...expected].sort());
}

describe("domain label completeness", () => {
  it("labels every appointment status and nothing else", () => {
    expectExactKeys(appointmentStatusBadges, appointmentStatuses);
    for (const status of appointmentStatuses) {
      const badge = appointmentStatusBadges[status];
      expect(badge.label.length).toBeGreaterThan(0);
      // The calendar renders the short code in a fixed-width badge.
      expect(badge.code).toMatch(/^[A-Z]{3}$/);
      expect(appointmentStatusLabel(status)).toBe(badge.label);
    }
  });

  it("labels every permission and nothing else", () => {
    expectExactKeys(permissionLabels, permissions);
  });

  it("labels every pet health issue and nothing else", () => {
    expectExactKeys(petHealthIssueLabels, petHealthIssues);
  });

  it("keeps rabies appointment labels separate from verification labels", () => {
    // `unverified` is a verification state only. It must not appear on the appointment table.
    expect(Object.keys(rabiesAppointmentStatusLabels)).not.toContain("unverified");
    expectExactKeys(rabiesVerificationStatusLabels, rabiesVerificationStatuses);
    for (const status of rabiesNeedsAttention) {
      expect(rabiesAppointmentStatusLabels[status]).toBeTruthy();
    }
  });

  it("labels every value of the enums that previously lived only in SQL", () => {
    expectExactKeys(invoiceStatusLabels, invoiceStatuses);
    expectExactKeys(paymentStatusLabels, paymentStatuses);
    expectExactKeys(paymentMethodLabels, paymentMethods);
    expectExactKeys(pricingModeLabels, pricingModes);
    expectExactKeys(serviceCategoryLabels, serviceCategories);
    expectExactKeys(pricingClassLabels, pricingClasses);
    for (const status of invoiceOutstandingStatuses) {
      expect(invoiceStatuses).toContain(status);
    }
  });
});

describe("shared formatting", () => {
  it("formats integer minor units as currency", () => {
    expect(formatMinor(8500)).toBe("$85.00");
    expect(formatMinor(0)).toBe("$0.00");
    expect(formatMinor(null)).toBe("$0.00");
    expect(formatMinor(undefined)).toBe("$0.00");
    expect(formatMinor(-2500)).toBe("-$25.00");
  });

  it("falls back to a readable string rather than throwing on an unusable currency", () => {
    // Hermes ships a reduced ICU and can reject a currency Node accepts. A receipt showing
    // "85.00 XYZ" is recoverable; a thrown error mid-checkout is not.
    expect(formatMinor(8500, "not-a-currency")).toBe("85.00 not-a-currency");
  });

  it("converts stored ounces to pounds for display", () => {
    expect(poundsFromOunces(320)).toBe(20);
    expect(poundsFromOunces(1152)).toBe(72);
    expect(poundsFromOunces(null)).toBeNull();
    expect(poundsFromOunces(undefined)).toBeNull();
  });
});
