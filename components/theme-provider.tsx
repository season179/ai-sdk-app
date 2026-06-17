"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * Wraps next-themes so the app tree can render from a server component
 * (`layout.tsx`) without making the whole layout a client component.
 *
 * `attribute="class"` toggles the `.dark` class on `<html>`, which is what the
 * token blocks in globals.css key off of. `defaultTheme="system"` follows the
 * OS preference on first visit; `enableSystem` resolves `system` to the actual
 * `prefers-color-scheme`. The no-flash inline script in `layout.tsx` sets the
 * class before paint so there's never a flash of the wrong theme.
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
