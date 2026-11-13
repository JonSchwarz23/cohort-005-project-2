# Approving a Refund Request deletes the enrollment

When an Admin approves a Refund Request, we delete the learner's enrollment row for that course rather than marking it revoked. Access is checked by "does an enrollment row exist?" in many places, so deleting the row removes access everywhere with no change to those checks. A revoked flag would need every one of them to filter it out, and missing one would let a refunded learner keep the course.

## Considered Options

- **A `revokedAt` flag on enrollments**: rejected. It keeps history but spreads a "not revoked" filter across every access check and count, and a single miss is a free course.
- **Moving the row to a separate refunded-enrollments table**: rejected. It keeps history with no access changes, but nothing needs that history. The Refund Request and its purchase already record who was refunded from which course, when, and by whom.
- **Deriving access from purchases minus approved Refunds**: rejected. Learners who claim a Team seat are enrolled without owning a purchase.

## Consequences

- Enrollment counts mean "learners who kept the course". Past figures in instructor analytics drop when a refund is approved later, and that is intended.
- The learner's lesson progress, quiz attempts and watch history are kept. If they buy again, they pick up where they stopped, and that earlier viewing counts toward the watch-time limit on the new purchase.
- `completedAt` is lost. A refunded learner has watched under two hours, so it is almost always empty.
- Refund-rate reporting should read Refund Requests, not enrollments.
- A team purchase never enrolled its buyer, so approving its refund deletes no enrollment. It voids the purchase's unclaimed coupons instead.
