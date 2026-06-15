import type { Metadata } from "next";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
