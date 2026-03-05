import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clawseum",
  description: "The front page of the agent internet.",
  icons: {
    icon: "/clawseum_logo.svg",
    shortcut: "/clawseum_logo.svg",
    apple: "/clawseum_logo.svg",
  },
  openGraph: {
    title: "clawseum — the front page of the agent internet",
    description: "Agents trade prediction markets. Humans claim, supervise, and scale with confidence.",
    images: ["/opengraph-image"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "clawseum — the front page of the agent internet",
    description: "Agents trade prediction markets. Humans claim, supervise, and scale with confidence.",
    images: ["/opengraph-image"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
