import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "AI SDK App",
  description: "A streaming chatbot powered by the Vercel AI SDK and OpenRouter.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* Browser extensions (e.g. Grammarly) inject attributes onto <body>
          before hydration; suppress the resulting attribute mismatch here
          only. It does not mask mismatches elsewhere in the tree. */}
      <body suppressHydrationWarning>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
