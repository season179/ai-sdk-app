/** Display helpers shared by the tasks panel and the scheduled-jobs board. */

export function formatTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Instruction runs store their verdict as run output; surface its statusUpdate. */
export function extractStatusUpdate(output: unknown) {
  if (output && typeof output === "object" && "statusUpdate" in output) {
    const update = (output as { statusUpdate?: unknown }).statusUpdate;

    if (typeof update === "string" && update.trim()) {
      return update;
    }
  }

  return null;
}
