import type { Database } from "../../src/db/client.js";

/**
 * A `postgres.js` stand-in that renders a tagged template - nested fragments included - and hands
 * the rendered statement to a responder.
 *
 * WHAT IT IS FOR. Three workers in this codebase claim rows with `for update skip locked` and a
 * bounded batch, and the thing that went wrong in all three was the CLAIM POLICY: which rows a
 * tick is allowed to see, in what order, and how the budget is divided. That policy is visible in
 * the statements a tick issues, so it can be pinned on every `npm test` rather than only where a
 * PostgreSQL instance happens to be available.
 *
 * WHAT IT IS NOT FOR. It cannot tell you that `skip locked` really makes two workers take
 * disjoint rows, that a status change really removes a row from the next statement's view, or
 * which index the planner chose. Those are properties of the server; asserting them against this
 * would be asserting the fake. They belong to the database suites next to these.
 *
 * A statement is recorded when it is AWAITED, which is what separates a claim from the fragments
 * composed into it: `db`and due.attempts=0`` is interpolated and never awaited, so it contributes
 * text and no execution.
 */

const FRAGMENT = Symbol("pawsh.test.fragment");

export interface Statement {
  text: string;
  values: unknown[];
}

export interface Recorder {
  db: Database;
  executed: Statement[];
}

export function recordingDatabase(
  respond: (statement: Statement, index: number) => unknown[]
): Recorder {
  const executed: Statement[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const parts: string[] = [];
    const bound: unknown[] = [];
    strings.forEach((chunk, index) => {
      parts.push(chunk);
      if (index >= values.length) return;
      const value = values[index];
      if (value && typeof value === "object" && FRAGMENT in (value as object)) {
        const fragment = value as { text: string; values: unknown[] };
        parts.push(fragment.text);
        bound.push(...fragment.values);
        return;
      }
      bound.push(value);
      parts.push(`$${bound.length}`);
    });
    const statement: Statement = { text: parts.join(""), values: bound };
    return {
      [FRAGMENT]: true,
      text: statement.text,
      values: statement.values,
      then(resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) {
        const index = executed.push(statement) - 1;
        try {
          return Promise.resolve(respond(statement, index)).then(resolve, reject);
        } catch (error) {
          return Promise.resolve().then(() => { throw error; }).then(resolve, reject);
        }
      }
    };
  };
  // `sql.begin` hands the callback a transaction that runs statements the same way. Recording
  // them on the same list is the point: a caller that wraps two writes in a transaction must
  // still be seen to issue both, and a fake without `begin` would silently divert every
  // transactional success path into its caller's error handler.
  (tag as unknown as { begin: unknown }).begin =
    <T>(work: (tx: Database) => Promise<T>): Promise<T> =>
      Promise.resolve(work(tag as unknown as Database));
  return { db: tag as unknown as Database, executed };
}

/** The statements that actually claimed rows, in the order the tick issued them. */
export function claimStatements(executed: Statement[]): Statement[] {
  return executed.filter((statement) => statement.text.includes("for update skip locked"));
}
