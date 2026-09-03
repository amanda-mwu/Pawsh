/**
 * The shared Pawsh domain.
 *
 * Everything exported here must run unchanged on Node and on React Native's Hermes engine, so
 * this package has **zero dependencies** and imports nothing from `node:`, no DOM API, and no
 * database driver. That constraint is enforced by its `tsconfig.json` (`"types": []`, so Node
 * globals are not even in scope) and by an empty `dependencies` block.
 *
 * Server-only domain code deliberately stays in `src/domain/`: wall-time resolution (`time.ts`)
 * depends on `Intl.DateTimeFormat` behavior Hermes does not reliably provide, and `canonical.ts`,
 * `catalog-seed.ts`, and `service-pricing.ts` need `node:crypto` or a database connection.
 */
export * from "./appointments.js";
export * from "./currency.js";
export * from "./preferences.js";
export * from "./weight.js";
export * from "./enums.js";
export * from "./labels.js";
export * from "./money.js";
export * from "./permissions.js";
export * from "./pet-care.js";
export * from "./presentation.js";
export * from "./pricing.js";
export * from "./rabies.js";
export * from "./wire.js";
export * from "./pets/dog-breeds.js";
