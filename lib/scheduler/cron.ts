import { CronExpressionParser } from "cron-parser";

/**
 * The single place cron expressions are parsed. pg-boss validates with the
 * same parser and options, so anything accepted here is also accepted by
 * boss.schedule and the catch-up reconciler. Throws the raw cron-parser error
 * on an invalid expression; callers that surface it to users wrap it.
 *
 * `currentDate` anchors the iterator (defaults to now inside cron-parser).
 * Pass the database clock when projecting fires so app-host clock skew cannot
 * shift the result.
 */
export function parseCronExpression(cron: string, timezone: string, currentDate?: Date) {
  return CronExpressionParser.parse(
    cron,
    currentDate === undefined ? { tz: timezone } : { tz: timezone, currentDate },
  );
}

/** Next fire strictly after `from`, in the task's timezone. */
export function nextCronFire(cron: string, timezone: string, from: Date): Date {
  return parseCronExpression(cron, timezone, from).next().toDate();
}

/** Most recent fire strictly before `from`, in the task's timezone. */
export function prevCronFire(cron: string, timezone: string, from: Date): Date {
  return parseCronExpression(cron, timezone, from).prev().toDate();
}
