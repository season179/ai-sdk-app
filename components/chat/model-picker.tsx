"use client";

import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OpenRouterModelSummary } from "@/lib/models/openrouter";

/** Cap rendered rows so a ~300-model list never paints hundreds of nodes. */
const MAX_RENDERED = 50;

export type ModelPickerProps = {
  /** Selected model id, or null before the user has chosen one. */
  value: string | null;
  /** Env default model id; used as the label fallback and the empty-list row. */
  defaultModel: string | null;
  models: OpenRouterModelSummary[];
  loading: boolean;
  disabled?: boolean;
  onChange: (modelId: string) => void;
  /** Fires when the popover opens; the parent uses it to lazy-fetch the list. */
  onOpen?: () => void;
};

function shortName(id: string): string {
  return id.split("/").pop() ?? id;
}

function formatContext(tokens: number | null): string | null {
  if (!tokens || tokens <= 0) {
    return null;
  }

  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

export function ModelPicker({
  value,
  defaultModel,
  models,
  loading,
  disabled,
  onChange,
  onOpen,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [lastResultKey, setLastResultKey] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // When the catalog is empty (no key / upstream error) still offer the default
  // so the user is never stuck and the label matches the env-default guarantee.
  const rows = useMemo<OpenRouterModelSummary[]>(() => {
    if (models.length > 0) {
      return models;
    }

    return defaultModel
      ? [{ id: defaultModel, name: shortName(defaultModel), contextLength: null }]
      : [];
  }, [models, defaultModel]);

  const normalizedQuery = query.trim().toLowerCase();
  const { matches, total } = useMemo(() => {
    if (!normalizedQuery) {
      return { matches: rows.slice(0, MAX_RENDERED), total: rows.length };
    }

    const prefix: OpenRouterModelSummary[] = [];
    const substring: OpenRouterModelSummary[] = [];

    for (const model of rows) {
      const id = model.id.toLowerCase();
      const name = model.name.toLowerCase();

      if (id.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) {
        prefix.push(model);
      } else if (id.includes(normalizedQuery) || name.includes(normalizedQuery)) {
        substring.push(model);
      }
    }

    const ranked = [...prefix, ...substring];
    return { matches: ranked.slice(0, MAX_RENDERED), total: ranked.length };
  }, [rows, normalizedQuery]);

  // Reset the highlight to the top whenever the result set changes — a new query
  // or the catalog arriving while the menu is open — in the same render so the
  // scroll effect fires once. Mirrors the skill-menu's render-time adjustment.
  const resultKey = `${rows.length}:${normalizedQuery}`;
  if (resultKey !== lastResultKey) {
    setLastResultKey(resultKey);
    setActiveIndex(0);
  }

  const highlighted = Math.min(activeIndex, Math.max(matches.length - 1, 0));
  const activeLabel = value ?? defaultModel;
  const activeModelName = models.find((model) => model.id === activeLabel)?.name;

  const openMenu = useCallback(() => {
    setOpen(true);
    setQuery("");
    setActiveIndex(0);
    onOpen?.();
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [onOpen]);

  const closeMenu = useCallback(() => {
    setOpen(false);
  }, []);

  const select = useCallback(
    (modelId: string) => {
      onChange(modelId);
      setOpen(false);
    },
    [onChange],
  );

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (open) {
      optionRefs.current[highlighted]?.scrollIntoView({ block: "nearest" });
    }
  }, [open, highlighted]);

  // Dismiss on outside click.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();

      if (matches.length === 0) {
        return;
      }

      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((highlighted + delta + matches.length) % matches.length);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const choice = matches[highlighted];

      if (choice) {
        select(choice.id);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex max-w-[12rem] items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50"
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        type="button"
      >
        <span className="truncate">
          {activeModelName ?? (activeLabel ? shortName(activeLabel) : "Default model")}
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
      </button>

      {open ? (
        <div
          className="absolute bottom-full left-0 z-50 mb-2 flex max-h-80 w-80 max-w-[80vw] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg"
          role="listbox"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              aria-label="Search models"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search models..."
              ref={searchRef}
              value={query}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {loading && rows.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                Loading models...
              </p>
            ) : matches.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No models match.
              </p>
            ) : (
              matches.map((model, index) => {
                const context = formatContext(model.contextLength);
                const isSelected = model.id === value;

                return (
                  <button
                    aria-selected={index === highlighted}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                      index === highlighted ? "bg-muted" : "hover:bg-muted/60"
                    }`}
                    key={model.id}
                    onClick={() => select(model.id)}
                    onMouseEnter={() => setActiveIndex(index)}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    role="option"
                    type="button"
                  >
                    <Check
                      aria-hidden="true"
                      className={`size-3.5 shrink-0 text-primary ${isSelected ? "opacity-100" : "opacity-0"}`}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-foreground">{model.name}</span>
                      <span className="ml-2 truncate text-[11px] text-muted-foreground">
                        {model.id}
                      </span>
                    </span>
                    {context ? (
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {context}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}

            {total > matches.length ? (
              <p className="px-3 py-2 text-center text-[11px] text-muted-foreground">
                Showing {matches.length} of {total}. Refine your search to see more.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
