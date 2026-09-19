/**
 * Nominal-typing helper. Two branded strings with different brand tags are
 * structurally incompatible even though both are `string` at runtime, which
 * is what lets `ContactId` and `ConversationId` (say) never be accidentally
 * swapped for one another at compile time.
 *
 * Pure type-level device — carries no runtime representation of its own.
 */
declare const __brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [__brand]: B };
