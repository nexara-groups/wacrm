"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Megaphone, MessagesSquare, Phone, Users, UserCog } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The single source of truth for top-level navigation.
 *
 * Every slice's screen is listed here from the start, including ones still
 * being built — a nav that only grows as screens land hides what the app is
 * meant to be. A link to a route that does not exist yet 404s, which is the
 * honest outcome; it is not styled as "coming soon" because nothing here
 * tracks build state.
 */
const LINKS = [
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/inbox", label: "Inbox", icon: MessagesSquare },
  { href: "/broadcasts", label: "Broadcasts", icon: Megaphone },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/settings/whatsapp", label: "WhatsApp", icon: Phone },
  { href: "/settings/team", label: "Team", icon: UserCog },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border bg-card">
      <nav className="mx-auto flex max-w-5xl items-center gap-1 px-4">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
