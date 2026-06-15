"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Chat" },
  { href: "/tasks", label: "Scheduled tasks" },
  { href: "/skills", label: "Skills" },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="-mx-2 flex min-w-0 items-center gap-1 sm:gap-2">
      {LINKS.map((link) => {
        const isActive = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);

        return (
          <Link
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative shrink-0 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
              isActive
                ? "text-foreground after:bg-primary"
                : "text-muted-foreground after:bg-transparent hover:bg-muted/60 hover:text-foreground",
            )}
            href={link.href}
            key={link.href}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
