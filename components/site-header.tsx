import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type SiteHeaderProps = {
  actions?: ReactNode;
  status?: ReactNode;
};

export function SiteHeader({ actions, status }: SiteHeaderProps) {
  return (
    <header className="sticky top-0 z-30 bg-background/95 px-4 py-3 backdrop-blur sm:px-8 lg:px-10">
      <div className="mx-auto flex min-h-8 w-full max-w-7xl flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {status}
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function SiteHeaderStatus({
  children,
  pulse = false,
}: {
  children: ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full bg-primary", pulse && "animate-pulse")}
      />
      <span className="truncate">{children}</span>
    </span>
  );
}
