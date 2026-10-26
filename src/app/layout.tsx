import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "StorySharp — Your Stories. Ready in Full Quality.",
  description: "Inspect and prepare photos and videos for Instagram Stories. Private, local processing with clear quality choices.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
