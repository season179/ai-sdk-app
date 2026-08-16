"use client";

import {
  AlertCircle,
  Clock3,
  Database,
  Lock,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { SiteHeader, SiteHeaderStatus } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import type { ProfileFactCategory, ProfileFactV1 } from "@/lib/profile/types";
import { cn } from "@/lib/utils";

type SourceSession = { sessionId: string; title: string | null; href: string };
type ProfileFact = ProfileFactV1 & {
  sourceCount: number;
  sourceSessions: SourceSession[];
};
type ProfileDto = {
  body: string;
  maxChars: number;
  version: {
    id: string;
    versionNo: number;
    trigger: "scheduled" | "explicit" | "manual_ui";
    authority: "synthesized" | "user";
    modelId: string | null;
    policyVersion: string;
    createdAt: string;
    charCount: number;
    tokenCount: number;
  } | null;
  facts: ProfileFact[];
  dirtyGeneration: number;
  synthesizedGeneration: number;
  dirty: boolean;
  lastSynthesisAttemptAt: string | null;
  lastSynthesizedAt: string | null;
  lastSynthesisError: string | null;
};

type ApiError = { error?: string; conflict?: boolean };

const CATEGORY_LABELS: Record<ProfileFactCategory, string> = {
  identity_context: "Identity and context",
  preferences_constraints: "Preferences and constraints",
  active_projects_goals: "Active projects and goals",
  interaction_instructions: "Interaction instructions",
};

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function readApiError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as ApiError | null;
  return {
    error: body?.error ?? "Request failed.",
    conflict: response.status === 409 && body?.conflict === true,
  };
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saveBusy, setSaveBusy] = useState(false);
  const [synthesisBusy, setSynthesisBusy] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const charCount = Array.from(draft).length;
  const maxChars = profile?.maxChars ?? 4500;

  const load = useCallback(async () => {
    setError(null);
    setConflict(false);
    setLoading(true);
    try {
      const response = await fetch("/api/profile");
      if (!response.ok) {
        const problem = await readApiError(response);
        throw new Error(problem.error);
      }
      const data = (await response.json()) as { profile?: ProfileDto };
      if (!data.profile) throw new Error("Profile response was incomplete.");
      setProfile(data.profile);
      setDraft(data.profile.body);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the profile.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function applyMutationProfile(next: ProfileDto) {
    setProfile(next);
    setDraft(next.body);
    setConflict(false);
  }

  async function save() {
    if (!profile) return;
    setSaveBusy(true);
    setError(null);
    setConflict(false);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft, expectedVersionId: profile.version?.id ?? null }),
      });
      if (!response.ok) {
        const problem = await readApiError(response);
        setConflict(Boolean(problem.conflict));
        throw new Error(
          problem.conflict
            ? "Profile changed on the server. Reload the latest version before retrying. Your draft is preserved."
            : problem.error,
        );
      }
      const data = (await response.json()) as { profile?: ProfileDto };
      if (!data.profile) throw new Error("Saved profile response was incomplete.");
      applyMutationProfile(data.profile);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the profile.");
    } finally {
      setSaveBusy(false);
    }
  }

  async function removeFact(fact: ProfileFact) {
    if (!profile) return;
    if (!window.confirm("This creates a durable exclusion so old chats cannot restore the fact.")) {
      return;
    }
    setDeletingKey(fact.factKey);
    setError(null);
    setConflict(false);
    try {
      const version = profile.version?.id;
      const query = version ? `?expectedVersionId=${encodeURIComponent(version)}` : "";
      const response = await fetch(
        `/api/profile/facts/${encodeURIComponent(fact.factKey)}${query}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const problem = await readApiError(response);
        setConflict(Boolean(problem.conflict));
        throw new Error(
          problem.conflict
            ? "Profile changed on the server. Reload the latest version before retrying. Your draft is preserved."
            : problem.error,
        );
      }
      const data = (await response.json()) as { profile?: ProfileDto };
      if (!data.profile) throw new Error("Updated profile response was incomplete.");
      applyMutationProfile(data.profile);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete the fact.");
    } finally {
      setDeletingKey(null);
    }
  }

  async function synthesize() {
    setSynthesisBusy(true);
    setError(null);
    setConflict(false);
    try {
      const response = await fetch("/api/profile/synthesize", { method: "POST" });
      if (!response.ok) {
        const problem = await readApiError(response);
        throw new Error(problem.error);
      }
      await load();
    } catch (synthesisError) {
      setError(
        synthesisError instanceof Error
          ? synthesisError.message
          : "Could not queue profile synthesis.",
      );
    } finally {
      setSynthesisBusy(false);
    }
  }

  const mutationBusy = saveBusy || synthesisBusy || deletingKey !== null;
  const draftChanged = profile ? draft !== profile.body : false;

  return (
    <>
      <SiteHeader
        actions={
          <Button
            disabled={loading || mutationBusy}
            onClick={() => void load()}
            size="sm"
            type="button"
            variant="outline"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </Button>
        }
        status={
          <SiteHeaderStatus pulse={loading || mutationBusy || Boolean(profile?.dirty)}>
            {loading
              ? "Loading profile"
              : profile?.dirty
                ? "New evidence pending synthesis"
                : profile?.version
                  ? "Saved profile active"
                  : "No active profile"}
          </SiteHeaderStatus>
        }
      />

      <main className="mx-auto w-full max-w-7xl px-4 pb-10 sm:px-8 lg:px-10">
        <h1 className="sr-only">Profile</h1>

        {error ? (
          <div
            className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
            role="alert"
          >
            <span>
              <AlertCircle className="mr-2 inline size-4" aria-hidden="true" />
              {error}
            </span>
            {conflict ? (
              <Button onClick={() => void load()} size="sm" type="button" variant="outline">
                Reload latest
              </Button>
            ) : null}
          </div>
        ) : null}

        {loading && !profile ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="h-80 animate-pulse rounded-lg bg-muted" />
            <div className="h-52 animate-pulse rounded-lg bg-muted" />
          </div>
        ) : profile ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
            <section className="min-w-0">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Injected profile text</h2>
                  <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground">
                    This exact text is attached to new chat turns. Use complete sentences under the
                    supported headings.
                  </p>
                </div>
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    charCount > maxChars ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {charCount.toLocaleString()} / {maxChars.toLocaleString()} characters
                </span>
              </div>

              <textarea
                aria-describedby="profile-editor-help"
                aria-label="Profile text"
                className="mt-4 min-h-80 w-full resize-y rounded-lg border border-input bg-card px-4 py-3 font-mono text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/30"
                disabled={saveBusy}
                onChange={(event) => setDraft(event.currentTarget.value)}
                placeholder="Identity and context\nWrite complete profile sentences here."
                spellCheck="true"
                value={draft}
              />
              <p id="profile-editor-help" className="mt-2 text-[11px] text-muted-foreground">
                Allowed headings: Identity and context; Preferences and constraints; Active projects
                and goals; Interaction instructions.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  disabled={
                    saveBusy || synthesisBusy || deletingKey !== null || charCount > maxChars
                  }
                  onClick={() => void save()}
                  type="button"
                >
                  <Save className="size-4" aria-hidden="true" />
                  {saveBusy ? "Saving profile…" : "Save profile"}
                </Button>
                <Button
                  disabled={mutationBusy}
                  onClick={() => void synthesize()}
                  type="button"
                  variant="outline"
                >
                  <Sparkles className="size-4" aria-hidden="true" />
                  {synthesisBusy ? "Queueing…" : "Re-synthesize now"}
                </Button>
                {draftChanged ? (
                  <span className="text-xs text-muted-foreground">Unsaved draft</span>
                ) : null}
              </div>

              <div className="mt-10 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Active facts</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Ordered claims and their durable provenance.
                  </p>
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {profile.facts.length} {profile.facts.length === 1 ? "fact" : "facts"}
                </span>
              </div>

              {profile.facts.length === 0 ? (
                <div className="mt-4 rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
                  No active facts. Save complete sentences above or synthesize from new evidence.
                </div>
              ) : (
                <ol className="mt-4 space-y-3">
                  {profile.facts.map((fact) => (
                    <li className="rounded-lg border border-border bg-card p-4" key={fact.factKey}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {CATEGORY_LABELS[fact.category]}
                            </span>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[10px] font-medium",
                                fact.authority === "user"
                                  ? "bg-primary/10 text-primary"
                                  : "bg-muted text-muted-foreground",
                              )}
                            >
                              {fact.authority === "user" ? "User" : "Synthesized"}
                            </span>
                            {fact.protected ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                <Lock className="size-3" aria-hidden="true" />
                                Protected
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-3 max-w-[72ch] text-sm leading-6">{fact.sentence}</p>
                          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Database className="size-3" aria-hidden="true" />
                              {fact.sourceCount} {fact.sourceCount === 1 ? "source" : "sources"}
                            </span>
                            {fact.sourceSessions.map((source) => (
                              <a
                                className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                                href={source.href}
                                key={source.sessionId}
                              >
                                {source.title?.trim() || "Source chat"}
                              </a>
                            ))}
                          </div>
                        </div>
                        <Button
                          aria-label={`Delete fact: ${fact.sentence}`}
                          disabled={mutationBusy}
                          onClick={() => void removeFact(fact)}
                          size="icon"
                          title="Delete fact"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2
                            className={cn(
                              "size-4",
                              deletingKey === fact.factKey
                                ? "animate-pulse text-muted-foreground"
                                : "text-destructive",
                            )}
                            aria-hidden="true"
                          />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <aside className="min-w-0 lg:sticky lg:top-20">
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-sm font-semibold">Profile state</h2>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    {profile.version ? `v${profile.version.versionNo}` : "No version"}
                  </span>
                </div>
                <p className="mt-3 flex items-center gap-2 text-sm">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      profile.dirty ? "animate-pulse bg-primary" : "bg-input",
                    )}
                    aria-hidden="true"
                  />
                  {profile.dirty ? "New evidence pending synthesis" : "Saved profile active"}
                </p>
                <dl className="mt-5 grid gap-3 text-xs">
                  <Metadata label="Authority" value={profile.version?.authority ?? "—"} />
                  <Metadata label="Trigger" value={profile.version?.trigger ?? "—"} />
                  <Metadata label="Model" value={profile.version?.modelId ?? "Manual / none"} />
                  <Metadata label="Policy" value={profile.version?.policyVersion ?? "—"} />
                  <Metadata
                    label="Generations"
                    value={`${profile.synthesizedGeneration} synthesized / ${profile.dirtyGeneration} dirty`}
                  />
                  <Metadata
                    label="Last synthesis"
                    value={formatDate(profile.lastSynthesizedAt)}
                    icon
                  />
                  <Metadata
                    label="Last attempt"
                    value={formatDate(profile.lastSynthesisAttemptAt)}
                    icon
                  />
                </dl>
              </div>

              {profile.lastSynthesisError ? (
                <div className="mt-4 rounded-lg border border-destructive/30 p-4 text-sm text-destructive">
                  <p className="font-medium">Last synthesis error</p>
                  <p className="mt-1 break-words text-xs">{profile.lastSynthesisError}</p>
                </div>
              ) : null}
            </aside>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
            Profile data is unavailable. Use Refresh to try again.
          </div>
        )}
      </main>
    </>
  );
}

function Metadata({
  label,
  value,
  icon = false,
}: {
  label: string;
  value: string;
  icon?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex items-start gap-1.5 break-words text-foreground">
        {icon ? (
          <Clock3 className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : null}
        {value}
      </dd>
    </div>
  );
}
