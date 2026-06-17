"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Cycles light → dark → system, matching what a developer expects from a
 * measurement tool that often runs for long sessions. Renders a stable
 * placeholder until mounted so the icon never flashes the wrong glyph and
 * server/client markup stays identical.
 */
export function ThemeToggle({ withLabel = true }: { withLabel?: boolean }) {
  const { resolvedTheme, setTheme, theme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  function cycle() {
    // next-themes exposes `theme` as the stored preference ("light" | "dark" |
    // "system"); fall back to resolvedTheme on the first click before mount.
    const current = theme ?? resolvedTheme;
    const next = current === "light" ? "dark" : current === "dark" ? "system" : "light";
    setTheme(next);
  }

  const effective = theme ?? resolvedTheme;
  // Avoid a flash of the wrong icon: before mount, show a neutral glyph.
  const Icon = !mounted
    ? Monitor
    : effective === "dark"
      ? Moon
      : effective === "light"
        ? Sun
        : Monitor;
  const label = !mounted
    ? "Theme"
    : effective === "dark"
      ? "Dark"
      : effective === "light"
        ? "Light"
        : "System";

  return (
    <button
      aria-label={`Theme: ${label.toLowerCase()}. Click to change.`}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/30",
        !withLabel && "mx-auto size-9 px-0",
      )}
      onClick={cycle}
      title={`Theme: ${label}`}
      type="button"
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {withLabel ? <span className="truncate">{label}</span> : null}
    </button>
  );
}
