"use client";

import { ArrowUp, Square } from "lucide-react";
import type * as React from "react";
import { forwardRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PromptInputMessage = {
  text: string;
};

export type PromptInputProps = Omit<React.FormHTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  onSubmit: (message: PromptInputMessage) => void;
};

export function PromptInput({ className, onSubmit, ...props }: PromptInputProps) {
  return (
    <form
      className={cn(
        "relative rounded-xl border border-border/80 bg-card/95 p-2 shadow-[var(--shadow-pop)] transition-shadow focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/10",
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSubmit({ text: String(data.get("message") ?? "") });
      }}
      {...props}
    />
  );
}

export const PromptInputTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function PromptInputTextarea({ className, ...props }, ref) {
  return (
    <textarea
      className={cn(
        "max-h-40 min-h-24 w-full resize-none rounded-md bg-transparent px-3 py-2 pr-16 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70",
        className,
      )}
      name="message"
      ref={ref}
      rows={3}
      {...props}
    />
  );
});

export function PromptInputSubmit({
  className,
  disabled,
  onClick,
  onStop,
  status,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  onStop?: () => void;
  status: "ready" | "submitted" | "streaming" | "error";
}) {
  const isBusy = status === "submitted" || status === "streaming";

  return (
    <Button
      {...props}
      aria-label={isBusy ? "Stop response" : "Send message"}
      className={cn("absolute bottom-3 right-3 rounded-full", className)}
      disabled={isBusy ? !onStop : disabled}
      onClick={(event) => {
        if (isBusy) {
          event.preventDefault();
          onStop?.();
          return;
        }

        onClick?.(event);
      }}
      size="icon"
      type={isBusy ? "button" : "submit"}
    >
      {isBusy ? <Square className="size-4 fill-current" /> : <ArrowUp className="size-4" />}
    </Button>
  );
}
