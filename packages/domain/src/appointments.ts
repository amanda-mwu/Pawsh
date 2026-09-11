export const appointmentStatuses = [
  "scheduled", "checked_in", "in_service", "completed", "cancelled", "no_show"
] as const;

export type AppointmentStatus = (typeof appointmentStatuses)[number];

/**
 * WHAT MAY FOLLOW WHAT.
 *
 * `checked_in -> completed` IS A REAL EDGE AND NOT A SHORTCUT AROUND `in_service`. The operator
 * action is called "Ready for Pickup", and what it records is that the work is finished and the
 * pet can go home - which is exactly what `completed` has always meant. Plenty of visits never
 * pass through `in_service`: a nail trim done at the counter, a bath the groomer never marked
 * started, a quiet morning where nobody touched the tablet between drop-off and pickup. Forcing
 * those through `in_service` would make the record say a service began at the moment it ended.
 *
 * `in_service` is not weakened by this. It still means the groomer is working on the pet now, it
 * is still reachable from `checked_in`, and it still leads to `completed`.
 *
 * AND `completed` STILL DOES NOT MEAN PAID. Nothing in this table has anything to say about
 * money: a visit may be billed and settled while it is `checked_in`, and finished without a
 * penny having been taken.
 */
const transitions: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  scheduled: ["checked_in", "cancelled", "no_show"],
  checked_in: ["in_service", "completed"],
  in_service: ["completed"],
  completed: [],
  cancelled: [],
  no_show: []
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return transitions[from].includes(to);
}

export function overlaps(
  first: { startAt: Date; endAt: Date },
  second: { startAt: Date; endAt: Date }
): boolean {
  return first.startAt < second.endAt && second.startAt < first.endAt;
}

/**
 * THE STATUSES A VISIT MAY BE CHECKED OUT FROM.
 *
 * Checkout used to require `completed`, which read as though billing were the last step of the
 * lifecycle. It is not. `completed` means the grooming work is finished and the pet is ready —
 * it says nothing about money, and an invoice may be raised and settled while the pet is still on
 * the table. The operator who takes payment at drop-off, or who bills a visit and hands the dog
 * back afterwards, was being told to finish work that was not finished yet.
 *
 * So a `checked_in` visit is billable too. The four states left out are left out because each is
 * a different kind of "not yet" or "never":
 *
 *   scheduled   nobody has arrived; there is nothing to bill for.
 *   in_service  the visit is mid-groom and its services are still being adjusted, so the bill it
 *               would raise is not the bill the visit ends up owing.
 *   cancelled   } no work happened and none will. A bill would be an invention rather than a
 *   no_show     } record, and neither state can move anywhere afterwards to justify one.
 *
 * ENTERING CHECKOUT IS NOT A TRANSITION. Nothing here advances a visit: a `checked_in`
 * appointment that raises an invoice is still `checked_in` afterwards, and the operator marks it
 * finished separately. Appointment status and invoice settlement are two independent facts about
 * the same visit and neither may be inferred from the other.
 */
export const checkoutEligibleStatuses = ["checked_in", "completed"] as const;

export function canEnterCheckout(status: AppointmentStatus | string): boolean {
  return (checkoutEligibleStatuses as readonly string[]).includes(status);
}
