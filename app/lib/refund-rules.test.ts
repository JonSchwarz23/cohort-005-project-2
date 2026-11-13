import { describe, it, expect } from "vitest";
import { RefundStatus } from "~/db/schema";
import {
  buildRefundDecisionEmail,
  checkDecision,
  daysIntoWindow,
  isWithinRefundWindow,
  MAX_WATCHED_SECONDS,
  refundWarnings,
} from "./refund-rules";

const openRequest = {
  decision: "approve" as const,
  status: RefundStatus.Open,
  decidedByName: null,
  adminId: 1,
  learnerId: 2,
  hasClaimedSeat: false,
};

describe("the refund window", () => {
  it("includes the whole of the fourteenth day", () => {
    const purchasedAt = new Date(2026, 0, 1, 23, 0).toISOString();
    expect(isWithinRefundWindow(purchasedAt, new Date(2026, 0, 15, 23, 59))).toBe(true);
    expect(isWithinRefundWindow(purchasedAt, new Date(2026, 0, 16, 0, 1))).toBe(false);
  });

  it("counts calendar days into the window", () => {
    const purchasedAt = new Date(2026, 0, 1, 23, 0).toISOString();
    expect(daysIntoWindow(purchasedAt, new Date(2026, 0, 1, 23, 30))).toBe(0);
    expect(daysIntoWindow(purchasedAt, new Date(2026, 0, 2, 0, 30))).toBe(1);
  });
});

describe("refundWarnings", () => {
  const purchasedAt = new Date(2026, 0, 1).toISOString();

  it("has nothing to say about a request still inside both limits", () => {
    expect(
      refundWarnings({ purchasedAt, watchedSeconds: 60, now: new Date(2026, 0, 5) })
    ).toEqual([]);
  });

  it("warns when the window has closed and the learner has watched too much", () => {
    const warnings = refundWarnings({
      purchasedAt,
      watchedSeconds: MAX_WATCHED_SECONDS,
      now: new Date(2026, 0, 20),
    });
    expect(warnings).toHaveLength(2);
  });
});

describe("checkDecision", () => {
  it("lets an Admin decide an Open Refund Request", () => {
    expect(checkDecision(openRequest)).toEqual({ ok: true });
    expect(checkDecision({ ...openRequest, decision: "decline" })).toEqual({ ok: true });
  });

  it("refuses any decision once the request is no longer Open, naming who decided", () => {
    expect(
      checkDecision({
        ...openRequest,
        decision: "decline",
        status: RefundStatus.Approved,
        decidedByName: "Alex Rivera",
      })
    ).toEqual({ ok: false, reason: "Already approved by Alex Rivera." });
    expect(
      checkDecision({ ...openRequest, status: RefundStatus.Declined }).ok
    ).toBe(false);
  });

  it("refuses an Admin deciding their own purchase", () => {
    expect(checkDecision({ ...openRequest, learnerId: 1 }).ok).toBe(false);
  });

  it("blocks approval, but not decline, once a team seat is claimed", () => {
    expect(checkDecision({ ...openRequest, hasClaimedSeat: true }).ok).toBe(false);
    expect(
      checkDecision({ ...openRequest, decision: "decline", hasClaimedSeat: true })
    ).toEqual({ ok: true });
  });
});

describe("buildRefundDecisionEmail", () => {
  const base = {
    learnerName: "Liam",
    learnerEmail: "liam@example.com",
    courseTitle: "Introduction to TypeScript",
    amount: 7900,
    decisionNote: null,
  };

  it("tells the learner the full amount and the loss of access on approval", () => {
    const email = buildRefundDecisionEmail({ ...base, decision: "approve" });
    expect(email.subject).toBe("Refund approved — Introduction to TypeScript");
    expect(email.body).toContain("$79.00");
    expect(email.body).toContain("no longer have access");
  });

  it("includes the Decision Note when there is one", () => {
    const email = buildRefundDecisionEmail({
      ...base,
      decision: "decline",
      decisionNote: "You have finished most of the course.",
    });
    expect(email.subject).toBe("Refund declined — Introduction to TypeScript");
    expect(email.body).toContain("You have finished most of the course.");
  });
});
