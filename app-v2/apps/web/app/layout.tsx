import type { Metadata } from "next";
import { AppNav } from "@/components/nav/app-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexara WACRM",
  description: "WhatsApp CRM — consent, deliverability and delivery health at a glance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
