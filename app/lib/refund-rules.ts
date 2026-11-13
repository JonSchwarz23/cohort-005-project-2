import { RefundStatus } from "~/db/schema";
import { formatPrice } from "~/lib/utils";

// The rules a learner's Refund Request is judged by. They decide eligibility
// when the request is raised. When an Admin decides, they are only shown as
// warnings — see refundWarnings.

export const REFUND_WINDOW_DAYS = 14;
export const MAX_WATCHED_HOURS = 2;
export const MAX_WATCHED_SECONDS = MAX_WATCHED_HOURS * 60 * 60;

// The fourteen-day window is counted in whole days, not hours — someone who
// buys at 23:00 should still get the whole of their fourteenth day.
export function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

export function lastDayOfWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

export function isWithinRefundWindow(
  purchasedAtIso: string,
  now: Date
): boolean {
  return calendarDay(now) <= lastDayOfWindow(purchasedAtIso);
}

/** Calendar days since the purchase: 0 on the day it was bought. */
export function daysIntoWindow(purchasedAtIso: string, now: Date): number {
  const purchased = new Date(purchasedAtIso);
  const start = Date.UTC(purchased.getFullYear(), purchased.getMonth(), purchased.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - start) / 86_400_000);
}

export function hasWatchedTooMuch(watchedSeconds: number): boolean {
  return watchedSeconds >= MAX_WATCHED_SECONDS;
}

/**
 * What an Admin should know before deciding: the request-time rules,
 * re-checked against today. These never block a decision.
 */
export function refundWarnings(input: {
  purchasedAt: string;
  watchedSeconds: number;
  now: Date;
}): string[] {
  const warnings: string[] = [];
  if (!isWithinRefundWindow(input.purchasedAt, input.now)) {
    warnings.push(
      `The ${REFUND_WINDOW_DAYS}-day window has closed since this was requested.`
    );
  }
  if (hasWatchedTooMuch(input.watchedSeconds)) {
    warnings.push(
      `The learner has now watched ${MAX_WATCHED_HOURS} hours or more.`
    );
  }
  return warnings;
}

export type RefundDecision = "approve" | "decline";

/**
 * Whether this Admin may make this decision on this Refund Request now.
 * The first decision is final: anything not Open is refused.
 */
export function checkDecision(input: {
  decision: RefundDecision;
  status: RefundStatus;
  decidedByName: string | null;
  adminId: number;
  learnerId: number;
  hasClaimedSeat: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.status !== RefundStatus.Open) {
    const verb =
      input.status === RefundStatus.Approved ? "approved" : "declined";
    return {
      ok: false,
      reason: input.decidedByName
        ? `Already ${verb} by ${input.decidedByName}.`
        : `Already ${verb}.`,
    };
  }
  if (input.adminId === input.learnerId) {
    return {
      ok: false,
      reason: "You cannot decide a Refund Request on your own purchase.",
    };
  }
  if (input.decision === "approve" && input.hasClaimedSeat) {
    return {
      ok: false,
      reason:
        "A team seat from this purchase has been claimed, so it cannot be approved.",
    };
  }
  return { ok: true };
}

/**
 * The decision email the learner gets. There is no mail transport wired up
 * yet, so the built message goes to the server log.
 */
export function buildRefundDecisionEmail(input: {
  decision: RefundDecision;
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
  decisionNote: string | null;
}) {
  const approved = input.decision === "approve";
  const lines = [`Hi ${input.learnerName},`, ""];

  if (approved) {
    lines.push(
      `We have approved your refund request for "${input.courseTitle}".`,
      `We will send back ${formatPrice(input.amount)}, the full amount you paid. You no longer have access to the course.`
    );
  } else {
    lines.push(
      `We have declined your refund request for "${input.courseTitle}".`,
      "You still have access to the course, and you can raise a new refund request if things change."
    );
  }

  if (input.decisionNote) {
    lines.push("", "A note from our team:", input.decisionNote);
  }

  lines.push("", "— The Cadence team");

  return {
    to: input.learnerEmail,
    subject: `Refund ${approved ? "approved" : "declined"} — ${input.courseTitle}`,
    body: lines.join("\n"),
  };
}
