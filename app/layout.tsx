import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "AI SDK App",
  description: "A streaming chatbot powered by the Vercel AI SDK and OpenRouter.",
};

// Runs before paint to set the theme class on <html> from the user's stored
// preference (or OS setting on first visit). Without it, the server renders
// light, and a dark-mode visitor would see a flash of light before next-themes
// hydrates. Kept inline + synchronous so it always beats first paint.
const noFlashScript = `(() => {
  try {
    const stored = localStorage.getItem("theme");
    const system = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = stored ? stored === "dark" : system;
    document.documentElement.classList.toggle("dark", dark);
  } catch {}
})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a synchronous, pre-paint theme script is the only way to avoid a flash of the wrong theme; noFlashScript is a static constant with no interpolation, so there is no injection surface. */}
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      {/* Browser extensions (e.g. Grammarly) inject attributes onto <body>
          before hydration; suppress the resulting attribute mismatch here
          only. It does not mask mismatches elsewhere in the tree. */}
      <body suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          storageKey="theme"
        >
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
