import { QueryClient, type QueryClient as QueryClientType } from "@tanstack/react-query";
import { isApiError } from "../api/errors";
import { queryKeys } from "./keys";

/**
 * Rate limiting is 120 requests per minute per IP, and a salon may have several phones behind one
 * router, so nothing here polls. Data refreshes when the groomer pulls, when a mutation
 * invalidates it, and when connectivity returns.
 */
export function createQueryClient(): QueryClientType {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A schedule changes when somebody acts on it, and every action in this app invalidates.
        // Half a minute is short enough that a second phone's check-in shows up on the next
        // screen visit, and long enough that walking between screens is not a request each time.
        staleTime: 30_000,
        // Cached reads outlive the screen that fetched them so a groomer who loses signal still
        // has the day in front of them rather than a spinner.
        gcTime: 24 * 60 * 60 * 1000,
        refetchOnReconnect: true,
        refetchOnMount: true,
        retry: (failureCount, error) => {
          // A 400 here may be the server's own fault — the backend answers unexpected faults
          // with 400 rather than 500 — but retrying it automatically would burn the rate limit
          // against a request that is not going to start working. Only genuinely transient
          // failures retry, and the UI always offers a manual retry.
          if (isApiError(error) && !error.retryable) return false;
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000)
      },
      mutations: {
        // A mutation is a groomer's deliberate action. Retrying it behind their back can replay a
        // state transition against a server whose state has already moved.
        retry: false
      }
    }
  });
}

/**
 * What to refresh after an appointment changed.
 *
 * The transition response is the bare `appointments` row, not the calendar projection, so it is
 * never written into the cache; the affected queries are invalidated and refetched instead.
 */
export async function invalidateAfterAppointmentChange(
  client: QueryClientType,
  options: { customerId?: string | null; petId?: string | null } = {}
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.appointments }),
    options.customerId
      ? client.invalidateQueries({ queryKey: queryKeys.customerHistory(options.customerId) })
      : Promise.resolve(),
    options.petId
      ? client.invalidateQueries({ queryKey: queryKeys.pet(options.petId) })
      : Promise.resolve()
  ]);
}
