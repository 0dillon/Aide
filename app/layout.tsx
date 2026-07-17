import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aide — voice-native work & pay",
  description: "Find work, prove your skills, and get paid — by voice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
