"use client";

import { AlertCircle, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";

import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import type { CatalogTool, ToolCatalogSnapshot } from "@/lib/tools/catalog-view";
import { cn } from "@/lib/utils";

type BackingFilter = "all" | "real" | "mocked";
type RuntimeFilter = "all" | "direct" | "search" | "unavailable";
type SchemaProperty = Record<string, unknown>;

const BACKING_FILTERS: Array<{ value: BackingFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "real", label: "Real" },
  { value: "mocked", label: "Mocked" },
];

const RUNTIME_FILTERS: Array<{ value: RuntimeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "direct", label: "Direct" },
  { value: "search", label: "Via search" },
  { value: "unavailable", label: "Unavailable" },
];

export function ToolCatalog({ snapshot }: { snapshot: ToolCatalogSnapshot }) {
  const [query, setQuery] = useState("");
  const [service, setService] = useState("all");
  const [backing, setBacking] = useState<BackingFilter>("all");
  const [runtime, setRuntime] = useState<RuntimeFilter>("all");

  const serviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tool of snapshot.tools) {
      counts.set(tool.service, (counts.get(tool.service) ?? 0) + 1);
    }
    return counts;
  }, [snapshot.tools]);

  const visibleTools = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return snapshot.tools.filter((tool) => {
      if (service !== "all" && tool.service !== service) return false;
      if (backing !== "all" && tool.backing !== backing) return false;
      if (runtime === "direct" && !tool.direct) return false;
      if (runtime === "search" && !tool.bridgeReachable) return false;
      if (runtime === "unavailable" && (tool.direct || tool.bridgeReachable)) return false;

      if (!needle) return true;

      return [
        tool.name,
        tool.title,
        tool.service,
        tool.action,
        tool.description,
        ...Object.keys(tool.properties),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [snapshot.tools, query, service, backing, runtime]);

  const visibleGroups = useMemo(() => {
    const groups = new Map<string, CatalogTool[]>();
    for (const tool of visibleTools) {
      const group = groups.get(tool.service) ?? [];
      group.push(tool);
      groups.set(tool.service, group);
    }
    return groups;
  }, [visibleTools]);

  const hasFilters = query !== "" || service !== "all" || backing !== "all" || runtime !== "all";

  function clearFilters() {
    setQuery("");
    setService("all");
    setBacking("all");
    setRuntime("all");
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-background">
      <h1 className="sr-only">Tool catalog</h1>
      <SiteHeader
        status={
          <SiteHeaderStatus>
            {snapshot.mode === "search" ? "Search mode" : "All-tools mode"} ·{" "}
            {snapshot.counts.total} tools · snapshot as of page load
          </SiteHeaderStatus>
        }
      />

      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 lg:px-10 lg:py-8">
        {snapshot.warning ? (
          <div
            className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/30 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p className="max-w-[72ch]">{snapshot.warning}</p>
          </div>
        ) : null}

        <div className="grid gap-8 lg:grid-cols-[minmax(16rem,21rem)_minmax(0,1fr)] lg:items-start lg:gap-10">
          <aside className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:pr-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <SlidersHorizontal aria-hidden="true" className="size-3.5" />
              Filter catalog
            </div>

            <label className="relative mt-3 block">
              <span className="sr-only">Search tools</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/30"
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search tools and parameters"
                type="search"
                value={query}
              />
            </label>

            <label className="mt-5 grid gap-1.5 text-xs font-medium text-muted-foreground">
              Service
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                onChange={(event) => setService(event.currentTarget.value)}
                value={service}
              >
                <option value="all">All services ({snapshot.counts.total})</option>
                {[...serviceCounts].map(([name, count]) => (
                  <option key={name} value={name}>
                    {formatService(name)} ({count})
                  </option>
                ))}
              </select>
            </label>

            <FilterGroup
              label="Implementation"
              onChange={setBacking}
              options={BACKING_FILTERS}
              value={backing}
            />
            <FilterGroup
              label="Runtime access"
              onChange={setRuntime}
              options={RUNTIME_FILTERS}
              value={runtime}
            />

            <div className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">{snapshot.counts.real} real</span>{" "}
                tools use app logic; {snapshot.counts.mocked} are deterministic mocks.
              </p>
              <p className="mt-2">
                {snapshot.mode === "search" ? (
                  <>
                    {snapshot.bridgeToolCount} bridge tools are direct;{" "}
                    {snapshot.counts.bridgeReachable} catalog tools are reachable through{" "}
                    <code className="font-mono">tool_call</code>.
                  </>
                ) : (
                  <>
                    The search bridge is off; {snapshot.counts.direct} catalog tools are direct now.
                  </>
                )}
              </p>
              <p className="mt-2 text-[11px]">
                Loaded <time dateTime={snapshot.asOf}>{formatLoadedAt(snapshot.asOf)}</time>.
              </p>
            </div>
          </aside>

          <section className="min-w-0" aria-live="polite">
            <div className="mb-5 flex min-h-8 flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">
                  {visibleTools.length}
                </span>{" "}
                of {snapshot.counts.total} tools visible
              </p>
              {hasFilters ? (
                <Button onClick={clearFilters} size="sm" type="button" variant="ghost">
                  <X aria-hidden="true" className="size-3.5" />
                  Clear filters
                </Button>
              ) : null}
            </div>

            {visibleTools.length === 0 ? (
              <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-16 text-center">
                <Search aria-hidden="true" className="size-7 text-muted-foreground" />
                <h2 className="mt-3 text-sm font-semibold">No matching tools</h2>
                <p className="mt-1 max-w-[55ch] text-sm text-muted-foreground">
                  Try a broader search or clear the service, implementation, and runtime filters.
                </p>
                <Button className="mt-4" onClick={clearFilters} size="sm" type="button">
                  Clear filters
                </Button>
              </div>
            ) : (
              <div className="space-y-10">
                {[...visibleGroups].map(([groupService, tools]) => (
                  <section key={groupService}>
                    <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-border pb-2">
                      <h2 className="text-sm font-semibold text-foreground">
                        {formatService(groupService)}
                      </h2>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {tools.length} visible / {serviceCounts.get(groupService) ?? tools.length}{" "}
                        total
                      </span>
                    </div>
                    <div className="grid gap-3">
                      {tools.map((tool) => (
                        <ToolCard key={tool.name} snapshot={snapshot} tool={tool} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function FilterGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="mt-5">
      <legend className="text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {options.map((option) => (
          <button
            aria-pressed={value === option.value}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/30",
              value === option.value
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function ToolCard({ tool, snapshot }: { tool: CatalogTool; snapshot: ToolCatalogSnapshot }) {
  const required = new Set(tool.required ?? []);
  const parameters = Object.entries(tool.properties);
  const nestedSchema = parameters.some(([, schema]) => hasNestedShape(schema));
  const runtime = runtimeLabel(tool);

  return (
    <article className="min-w-0 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{tool.title}</h3>
          <code className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
            {tool.name}
          </code>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              tool.backing === "real"
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            )}
            title={
              tool.backing === "real"
                ? "Backed by real application logic"
                : "Backed by deterministic mock logic"
            }
          >
            {tool.backing === "real" ? "Real" : "Mocked"}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-foreground">
            {runtime}
          </span>
        </div>
      </div>

      <p className="mt-3 max-w-[72ch] text-sm leading-5 text-muted-foreground">
        {tool.description}
      </p>
      <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">{formatService(tool.service)}</span>
        <span>Action: {tool.action}</span>
      </div>

      {tool.gate ? (
        <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
          {gateNote(tool, snapshot)}
        </p>
      ) : null}

      <details className="group mt-4 border-t border-border pt-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          />
          Parameters
          <span className="font-normal text-muted-foreground">
            {parameters.length} total · {required.size} required
          </span>
        </summary>

        {parameters.length === 0 ? (
          <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            No parameters.
          </p>
        ) : (
          <div className="mt-3 overflow-hidden rounded-md border border-border">
            <div className="hidden grid-cols-[minmax(7rem,0.8fr)_5.5rem_minmax(6rem,0.7fr)_minmax(9rem,1fr)_minmax(12rem,1.5fr)] gap-3 border-b border-border bg-muted/60 px-3 py-2 text-[10px] font-medium uppercase text-muted-foreground md:grid">
              <span>Name</span>
              <span>Need</span>
              <span>Type</span>
              <span>Enum / constraints</span>
              <span>Description</span>
            </div>
            {parameters.map(([name, schema]) => (
              <div
                className="grid gap-1 border-b border-border px-3 py-2.5 text-xs last:border-b-0 md:grid-cols-[minmax(7rem,0.8fr)_5.5rem_minmax(6rem,0.7fr)_minmax(9rem,1fr)_minmax(12rem,1.5fr)] md:gap-3"
                key={name}
              >
                <code className="break-all font-mono text-[11px] text-foreground">{name}</code>
                <span
                  className={
                    required.has(name) ? "font-medium text-foreground" : "text-muted-foreground"
                  }
                >
                  {required.has(name) ? "Required" : "Optional"}
                </span>
                <span className="text-muted-foreground">{schemaType(schema)}</span>
                <span className="break-words text-muted-foreground">
                  {schemaConstraints(schema)}
                </span>
                <span className="text-muted-foreground">
                  {typeof schema.description === "string" ? schema.description : "—"}
                </span>
              </div>
            ))}
          </div>
        )}

        {nestedSchema ? (
          <div className="mt-4">
            <p className="text-[11px] font-medium text-muted-foreground">Raw JSON Schema</p>
            <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-5 text-foreground">
              {JSON.stringify(parameterSchema(tool), null, 2)}
            </pre>
          </div>
        ) : null}
      </details>
    </article>
  );
}

function runtimeLabel(tool: CatalogTool): string {
  if (tool.direct && tool.bridgeReachable) return "Direct + searchable";
  if (tool.direct) return "Direct";
  if (tool.bridgeReachable) return "Via tool search";
  return "Disabled";
}

function gateNote(tool: CatalogTool, snapshot: ToolCatalogSnapshot): string {
  if (tool.gate === "memory") {
    return snapshot.memorySearchEnabled
      ? "Direct access is enabled by MEMORY_SEARCH_ENABLED. Memory search is never bridge-reachable."
      : "Direct access requires MEMORY_SEARCH_ENABLED. Memory search is never bridge-reachable.";
  }

  if (snapshot.skillAvailability === "enabled") {
    return "Direct access is enabled because at least one database skill is enabled. In search mode, this tool is also bridge-reachable.";
  }
  if (snapshot.skillAvailability === "unknown") {
    return "Enabled-skill state is unknown, so direct access cannot be confirmed. In search mode, this tool remains bridge-reachable.";
  }
  return "Direct access requires at least one enabled database skill. In search mode, this tool remains bridge-reachable.";
}

function parameterSchema(tool: CatalogTool) {
  return {
    type: "object",
    properties: tool.properties,
    required: tool.required ?? [],
    additionalProperties: false,
  };
}

function hasNestedShape(schema: SchemaProperty): boolean {
  const items =
    schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
      ? (schema.items as SchemaProperty)
      : null;

  return (
    schema.type === "object" ||
    ["properties", "anyOf", "allOf", "oneOf"].some((key) => key in schema) ||
    (schema.type === "array" &&
      items !== null &&
      (items.type === "object" ||
        ["properties", "anyOf", "allOf", "oneOf"].some((key) => key in items)))
  );
}

function schemaType(schema: SchemaProperty): string {
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (typeof schema.type === "string") {
    if (schema.type === "array" && schema.items && typeof schema.items === "object") {
      const itemType = (schema.items as SchemaProperty).type;
      return typeof itemType === "string" ? `array<${itemType}>` : "array";
    }
    return schema.type;
  }
  return "—";
}

function schemaConstraints(schema: SchemaProperty): string {
  const parts: string[] = [];
  if (Array.isArray(schema.enum)) {
    parts.push(`enum: ${schema.enum.map(String).join(", ")}`);
  }

  const labels: Array<[string, string]> = [
    ["minimum", "min"],
    ["maximum", "max"],
    ["minLength", "min length"],
    ["maxLength", "max length"],
    ["minItems", "min items"],
    ["maxItems", "max items"],
    ["pattern", "pattern"],
    ["format", "format"],
    ["default", "default"],
  ];
  for (const [key, label] of labels) {
    if (schema[key] !== undefined) parts.push(`${label}: ${String(schema[key])}`);
  }

  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    parts.push(`${Object.keys(schema.properties).length} nested fields`);
  }
  return parts.join(" · ") || "—";
}

function formatService(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatLoadedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "at page load";
  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}
