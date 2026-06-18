"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/**
 * Theme selector. Two shapes share one component so the sidebar footer keeps a
 * single affordance whether the rail is expanded or collapsed:
 *
 *  - Expanded (`withLabel`): a segmented `Light | Dark | System` control. The
 *    active segment reads as selection (solid `bg-background` on the muted
 *    track) rather than a cycling mystery button — every option is one tap.
 *  - Collapsed rail: a single icon button that still cycles, since the rail is
 *    too narrow for three segments.
 *
 * Renders a neutral placeholder until mount so the icon never flashes the wrong
 * glyph and server/client markup stays identical.
 */
export function ThemeToggle({ withLabel = true }: { withLabel?: boolean }) {
  const { resolvedTheme, setTheme, theme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const effective = theme ?? resolvedTheme;

  if (withLabel) {
    return (
      // The three labeled buttons are self-describing; no group role is needed,
      // and `role="group"`/`radiogroup` would trip useSemanticElements (it maps
      // to <fieldset>/<input type=radio>, neither of which fits a toggle).
      <div className="inline-flex h-9 w-full items-center gap-0.5 rounded-md bg-muted/60 p-0.5 text-xs font-medium">
        {OPTIONS.map(({ Icon, label, value }) => {
          const isActive = mounted && effective === value;
          return (
            <button
              aria-label={label}
              aria-pressed={isActive}
              className={cn(
                "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[calc(theme(borderRadius.md)-2px)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/30",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              // Avoid SSR/mount mismatch: don't commit a selection until we know
              // the stored preference. The segments still render, just inert.
              disabled={!mounted}
              key={value}
              onClick={() => setTheme(value)}
              title={label}
              type="button"
            >
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
    );
  }

  // Collapsed rail: one icon that cycles, mirroring the old behavior. The rail
  // is too narrow for three segments, so a single tap-through is the honest UX.
  const order = OPTIONS.map(({ value }) => value);
  // findIndex, not indexOf: `effective` from next-themes is `string | undefined`,
  // which indexOf's narrowed tuple signature rejects but === comparison accepts.
  // biome-ignore lint/complexity/useIndexOf: indexOf can't accept the `string | undefined` from next-themes' useTheme(); === comparison can.
  const currentIndex = order.findIndex((value) => value === effective);
  const current = OPTIONS[currentIndex] ?? OPTIONS[2];
  // Neutral placeholder until mount so server/client markup stays identical and
  // the icon never flashes the wrong glyph.
  const RailIcon = mounted ? current.Icon : Monitor;
  const railLabel = mounted ? current.label : "Theme";
  const cycleNext = order[(currentIndex + 1) % order.length];

  return (
    <button
      aria-label={`Theme: ${railLabel.toLowerCase()}. Click to change.`}
      className="mx-auto inline-flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/30"
      onClick={() => setTheme(cycleNext)}
      title={`Theme: ${railLabel}`}
      type="button"
    >
      <RailIcon aria-hidden="true" className="size-4 shrink-0" />
    </button>
  );
}
