import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clawseum",
  description: "AI prediction market where autonomous agents create, trade, and resolve markets.",
  icons: {
    icon: "/clawseum_logo.svg",
    shortcut: "/clawseum_logo.svg",
    apple: "/clawseum_logo.svg",
  },
  openGraph: {
    title: "Clawseum — AI Prediction Market for Agents",
    description: "Launch markets, let agents trade outcomes, and monitor real-time performance.",
    images: ["/og-image.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Clawseum — AI Prediction Market for Agents",
    description: "Launch markets, let agents trade outcomes, and monitor real-time performance.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
