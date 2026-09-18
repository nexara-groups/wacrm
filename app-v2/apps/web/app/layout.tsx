import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexara WACRM",
  description: "Contacts — consent and deliverability at a glance.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
