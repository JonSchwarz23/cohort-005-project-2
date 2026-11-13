import { and, count, desc, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  coupons,
  courses,
  enrollments,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
  RefundStatus,
} from "~/db/schema";
import {
  buildRefundDecisionEmail,
  checkDecision,
  daysIntoWindow,
  refundWarnings,
  type RefundDecision,
} from "~/lib/refund-rules";

/**
 * How far a learner has got through a course's videos: the furthest position
 * reached in each lesson, added up.
 */
export function getWatchedSeconds(userId: number, courseId: number): number {
  const lessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (lessonIds.length === 0) return 0;

  return db
    .select({ furthest: sql<number>`max(${videoWatchEvents.positionSeconds})` })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

export function hasClaimedSeat(purchaseId: number): boolean {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt)))
    .get();
}

/** A team purchase bought coupons rather than enrolling its buyer. */
export function isTeamPurchase(purchaseId: number): boolean {
  return !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
}

export function countOpenRefundRequests(): number {
  return (
    db
      .select({ n: count() })
      .from(refunds)
      .where(eq(refunds.status, RefundStatus.Open))
      .get()?.n ?? 0
  );
}

const learners = alias(users, "learners");
const deciders = alias(users, "deciders");

function selectRefundRequests() {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      decisionNote: refunds.decisionNote,
      amountRefunded: refunds.amountRefunded,
      decidedByName: deciders.name,
      purchaseId: purchases.id,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      learnerId: learners.id,
      learnerName: learners.name,
      learnerEmail: learners.email,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .innerJoin(learners, eq(purchases.userId, learners.id))
    .leftJoin(deciders, eq(refunds.resolvedByUserId, deciders.id));
}

/** Open Refund Requests, oldest first, with what an Admin needs to decide. */
export function listOpenRefundRequests(now: Date) {
  return selectRefundRequests()
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt))
    .all()
    .map((request) => {
      const watchedSeconds = getWatchedSeconds(request.learnerId, request.courseId);
      return {
        ...request,
        watchedSeconds,
        daysIntoWindow: daysIntoWindow(request.purchasedAt, now),
        warnings: refundWarnings({
          purchasedAt: request.purchasedAt,
          watchedSeconds,
          now,
        }),
        hasClaimedSeat: hasClaimedSeat(request.purchaseId),
        isTeamPurchase: isTeamPurchase(request.purchaseId),
        earlierDeclinedOnPurchase: countRefundRequests(
          and(
            eq(refunds.purchaseId, request.purchaseId),
            eq(refunds.status, RefundStatus.Declined)
          )
        ),
        earlierApprovedOnCourse: countEarlierApprovedOnCourse(
          request.learnerId,
          request.courseId,
          request.purchaseId
        ),
      };
    });
}

/** Decided Refund Requests with the given status, newest decision first. */
export function listDecidedRefundRequests(
  status: RefundStatus.Approved | RefundStatus.Declined
) {
  return selectRefundRequests()
    .where(eq(refunds.status, status))
    .orderBy(desc(refunds.resolvedAt))
    .all();
}

function countRefundRequests(where: ReturnType<typeof and>): number {
  return db.select({ n: count() }).from(refunds).where(where).get()?.n ?? 0;
}

function countEarlierApprovedOnCourse(
  learnerId: number,
  courseId: number,
  currentPurchaseId: number
): number {
  return (
    db
      .select({ n: count() })
      .from(refunds)
      .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
      .where(
        and(
          eq(purchases.userId, learnerId),
          eq(purchases.courseId, courseId),
          ne(purchases.id, currentPurchaseId),
          eq(refunds.status, RefundStatus.Approved)
        )
      )
      .get()?.n ?? 0
  );
}

export type DecideResult = { ok: true } | { ok: false; reason: string };

/**
 * Approve or decline a Refund Request. The first decision is final.
 *
 * Approving sets the Refund to the full amount paid (a Pending Refund — no
 * money moves here), deletes the learner's enrollment (ADR 0001) and voids
 * every unclaimed coupon from the purchase.
 */
export function decideRefundRequest(input: {
  refundId: number;
  adminId: number;
  decision: RefundDecision;
  decisionNote: string | null;
}): DecideResult {
  const outcome = db.transaction((tx): DecideResult & { email?: ReturnType<typeof buildRefundDecisionEmail> } => {
    const request = tx
      .select({
        status: refunds.status,
        decidedByName: deciders.name,
        purchaseId: purchases.id,
        amountPaid: purchases.amountPaid,
        courseId: courses.id,
        courseTitle: courses.title,
        learnerId: learners.id,
        learnerName: learners.name,
        learnerEmail: learners.email,
      })
      .from(refunds)
      .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .innerJoin(learners, eq(purchases.userId, learners.id))
      .leftJoin(deciders, eq(refunds.resolvedByUserId, deciders.id))
      .where(eq(refunds.id, input.refundId))
      .get();

    if (!request) return { ok: false, reason: "Refund Request not found." };

    const check = checkDecision({
      decision: input.decision,
      status: request.status,
      decidedByName: request.decidedByName,
      adminId: input.adminId,
      learnerId: request.learnerId,
      hasClaimedSeat: hasClaimedSeat(request.purchaseId),
    });
    if (!check.ok) return check;

    const now = new Date().toISOString();
    const approved = input.decision === "approve";

    // Guarded on status so a decision that lands in between can't be
    // overwritten: only one update can move a request out of Open.
    const updated = tx
      .update(refunds)
      .set({
        status: approved ? RefundStatus.Approved : RefundStatus.Declined,
        amountRefunded: approved ? request.amountPaid : null,
        resolvedAt: now,
        resolvedByUserId: input.adminId,
        decisionNote: input.decisionNote,
      })
      .where(and(eq(refunds.id, input.refundId), eq(refunds.status, RefundStatus.Open)))
      .returning({ id: refunds.id })
      .get();

    if (!updated) return { ok: false, reason: "This Refund Request has already been decided." };

    // A team purchase never enrolled its buyer — it bought coupons. Its
    // refund voids those, and leaves any enrollment the buyer got elsewhere.
    const teamPurchase = isTeamPurchase(request.purchaseId);

    if (approved && !teamPurchase) {
      tx.delete(enrollments)
        .where(
          and(
            eq(enrollments.userId, request.learnerId),
            eq(enrollments.courseId, request.courseId)
          )
        )
        .run();
    }

    if (approved && teamPurchase) {
      tx.update(coupons)
        .set({ voidedAt: now })
        .where(
          and(
            eq(coupons.purchaseId, request.purchaseId),
            isNull(coupons.redeemedAt),
            isNull(coupons.voidedAt)
          )
        )
        .run();
    }

    return {
      ok: true,
      email: buildRefundDecisionEmail({
        decision: input.decision,
        learnerName: request.learnerName,
        learnerEmail: request.learnerEmail,
        courseTitle: request.courseTitle,
        amount: request.amountPaid,
        decisionNote: input.decisionNote,
      }),
    };
  });

  if (!outcome.ok) return outcome;

  if (outcome.email) {
    console.log(
      `[email] to=${outcome.email.to} subject=${outcome.email.subject}\n${outcome.email.body}`
    );
  }
  return { ok: true };
}
