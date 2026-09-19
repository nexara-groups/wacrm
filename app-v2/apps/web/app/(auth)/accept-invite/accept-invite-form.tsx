"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Accepts an invitation and sets the invitee's password in one step — they
 * have no credential yet, so there is no "log in first" option here. Posts
 * to `/api/auth/accept-invite` (public — see that route's header) with the
 * raw token from the URL (`?token=...`, exactly what
 * `buildInvitationAcceptUrl` puts in the emailed link) and the chosen
 * password.
 *
 * Deliberately does NOT log the new member in itself — same reasoning as
 * `SignupPage`: accepting and logging in stay two separate requests. On
 * success this redirects to `/login`, same destination signup uses.
 */
export default function AcceptInviteForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || (payload as { ok?: boolean }).ok !== true) {
        const message =
          (payload as { error?: { laymanMessage?: string } }).error?.laymanMessage ??
          "Something went wrong. Please try again.";
        setError(message);
        return;
      }
      // Full navigation, same as signup: this call doesn't set a session
      // cookie, so the new member signs in on /login with the password
      // they just chose.
      window.location.assign("/login?invitationAccepted=1");
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (token.length === 0) {
    return (
      <main className="mx-auto flex max-w-sm flex-col justify-center px-4 py-24">
        <Card>
          <CardHeader>
            <CardTitle>Invalid invitation link</CardTitle>
            <CardDescription>
              This link is missing its invitation token. Ask whoever invited you to resend it.
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col justify-center px-4 py-24">
      <Card>
        <CardHeader>
          <CardTitle>Accept your invitation</CardTitle>
          <CardDescription>Choose a password to finish setting up your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">At least 12 characters.</p>
            </div>
            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={submitting} className="mt-1 w-full">
              {submitting ? "Accepting invitation…" : "Accept invitation"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
