/**
 * Auth wire contracts — request validation and the record -> wire DTO for
 * the authenticated user.
 *
 * Same discipline as `lib/contact-dto.ts`: every response is parsed through
 * a zod schema before it leaves the process, so a field the shape forgot
 * fails loudly here instead of shipping silently missing.
 */
import { z } from "zod";
import type { AuthUser } from "@nexara/core/auth";
import { ROLES } from "@nexara/core/rbac";

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

export const loginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1, "Password is required"),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ---------------------------------------------------------------------------
// the authenticated-user wire shape
// ---------------------------------------------------------------------------

export const authUserSchema = z.object({
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  email: z.email(),
  role: z.enum(ROLES),
});
export type AuthUserDTO = z.infer<typeof authUserSchema>;

export function toAuthUserDTO(user: AuthUser): AuthUserDTO {
  return authUserSchema.parse({
    userId: user.userId,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
  });
}
