export * from "./generated/api";
export * from "./generated/types";
// Orval emits both a query schema and a query type with this name.
// Prefer the validation schema at the root; keep the input type available.
export { DeleteMatchDraftParams } from "./generated/api";
export type { DeleteMatchDraftParams as DeleteMatchDraftQuery } from "./generated/types";
