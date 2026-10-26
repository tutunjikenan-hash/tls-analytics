import "@fontsource-variable/hanken-grotesk";
import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "TLS Analytics",
  description: "Real-time analytics for The Last Shift",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#10151f", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
