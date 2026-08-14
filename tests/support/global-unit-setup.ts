/**
 * The unit project deliberately carries no database coverage. Saying so out loud stops a green
 * `npm test` from being read as "the database suites passed" — they are simply not in scope here.
 */
export default function setup(): void {
  console.info('[pawsh] unit project: database suites are OUT OF SCOPE for `npm test`. Run `npm run test:db` for database coverage.');
}
