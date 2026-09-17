/**
 * @packages/contracts — zod request/response schemas for every WACRM
 * surface (web, mobile, server). Every exported `*Schema` also exports its
 * `z.infer`-derived type; there is no hand-written type anywhere in this
 * package that duplicates a schema. Only runtime dependency: zod.
 */
export * from "./common";

export * from "./contacts";
export * from "./conversations";
export * from "./messages";
export * from "./broadcasts";
export * from "./templates";
export * from "./invitations";
export * from "./seats";
export * from "./onboarding";
export * from "./platform-admin";
