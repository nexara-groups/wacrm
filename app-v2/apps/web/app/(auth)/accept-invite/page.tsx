import { Suspense } from "react";
import AcceptInviteForm from "./accept-invite-form";

/**
 * `/accept-invite?token=...` — the destination of the link
 * `buildInvitationAcceptUrl` (`lib/email-templates.ts`) puts in every
 * invitation email. Public — see `proxy.ts`'s `PUBLIC_PAGE_PATHS`.
 *
 * A server component wrapper only: the form itself reads the token via
 * `useSearchParams`, a Client Component hook that (per
 * node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md)
 * requires a `Suspense` boundary around it for production builds.
 */
export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInviteForm />
    </Suspense>
  );
}
