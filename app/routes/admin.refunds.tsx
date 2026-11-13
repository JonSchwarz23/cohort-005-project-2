import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { RefundStatus, UserRole, users } from "~/db/schema";
import { db } from "~/db";
import { eq } from "drizzle-orm";
import {
  decideRefundRequest,
  listDecidedRefundRequests,
  listOpenRefundRequests,
} from "~/lib/refunds.server";
import {
  MAX_WATCHED_HOURS,
  REFUND_WINDOW_DAYS,
  type RefundDecision,
} from "~/lib/refund-rules";
import { cn, formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { AlertTriangle, ReceiptText } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";

const TABS = [
  { value: "open", label: "Open" },
  { value: "approved", label: "Approved" },
  { value: "declined", label: "Declined" },
] as const;
type Tab = (typeof TABS)[number]["value"];

const decideSchema = z.object({
  refundId: z.coerce.number().int(),
  decision: z.enum(["approve", "decline"]),
  decisionNote: z
    .string()
    .trim()
    .max(1000, "Please keep the note under 1000 characters.")
    .optional()
    .transform((note) => note || null),
});

function requireAdmin(userId: number | null, message: string) {
  if (!userId) {
    throw data("Select a user from the DevUI panel to manage refunds.", {
      status: 401,
    });
  }
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== UserRole.Admin) {
    throw data(message, { status: 403 });
  }
  return user;
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const admin = requireAdmin(
    await getCurrentUserId(request),
    "Only admins can access this page."
  );

  const tabParam = new URL(request.url).searchParams.get("tab");
  const tab: Tab = TABS.some((t) => t.value === tabParam)
    ? (tabParam as Tab)
    : "open";

  return {
    tab,
    adminId: admin.id,
    open: tab === "open" ? listOpenRefundRequests(new Date()) : [],
    decided:
      tab === "approved"
        ? listDecidedRefundRequests(RefundStatus.Approved)
        : tab === "declined"
          ? listDecidedRefundRequests(RefundStatus.Declined)
          : [],
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = requireAdmin(
    await getCurrentUserId(request),
    "Only admins can decide Refund Requests."
  );

  const parsed = parseFormData(await request.formData(), decideSchema);
  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const result = decideRefundRequest({
    refundId: parsed.data.refundId,
    adminId: admin.id,
    decision: parsed.data.decision,
    decisionNote: parsed.data.decisionNote,
  });

  if (!result.ok) {
    return data({ error: result.reason }, { status: 409 });
  }
  return { success: true, decision: parsed.data.decision };
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatWatched(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

type OpenRequest = Route.ComponentProps["loaderData"]["open"][number];
type DecidedRequest = Route.ComponentProps["loaderData"]["decided"][number];

function DecisionDialog({
  request,
  decision,
  disabledReason,
}: {
  request: OpenRequest;
  decision: RefundDecision;
  disabledReason: string | null;
}) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const submitting = fetcher.state !== "idle";
  const approving = decision === "approve";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("error" in fetcher.data) {
      toast.error(fetcher.data.error);
      setOpen(false);
    } else if (fetcher.data.success) {
      toast.success(approving ? "Refund Request approved." : "Refund Request declined.");
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data, approving]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant={approving ? "default" : "outline"}
          disabled={!!disabledReason}
          title={disabledReason ?? undefined}
        >
          {approving ? "Approve" : "Decline"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {approving
              ? `Approve ${formatPrice(request.amountPaid)} refund for ${request.learnerName}?`
              : `Decline ${request.learnerName}'s Refund Request?`}
          </DialogTitle>
          <DialogDescription>
            {approving
              ? request.isTeamPurchase
                ? `This voids every unclaimed coupon from this team purchase and records a Pending Refund of the full amount paid.`
                : `This removes ${request.learnerName}'s access to ${request.courseTitle} and records a Pending Refund of the full amount paid.`
              : `${request.learnerName} keeps access to ${request.courseTitle} and can raise a new Refund Request.`}{" "}
            This decision is final.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" className="space-y-4">
          <input type="hidden" name="refundId" value={request.id} />
          <input type="hidden" name="decision" value={decision} />
          <div className="space-y-2">
            <Label htmlFor={`note-${decision}-${request.id}`}>
              Decision Note (optional)
            </Label>
            <Textarea
              id={`note-${decision}-${request.id}`}
              name="decisionNote"
              rows={3}
              maxLength={1000}
              placeholder={`${request.learnerName} will see this note.`}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={approving ? "default" : "destructive"}
              disabled={submitting}
            >
              {submitting ? "Saving..." : approving ? "Approve refund" : "Decline request"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function OpenRequestCard({
  request,
  adminId,
}: {
  request: OpenRequest;
  adminId: number;
}) {
  const ownPurchase = request.learnerId === adminId;
  const ownPurchaseReason = ownPurchase
    ? "You cannot decide a Refund Request on your own purchase."
    : null;
  const seatReason = request.hasClaimedSeat
    ? "A team seat from this purchase has been claimed, so it cannot be approved."
    : null;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-semibold">
              {request.learnerName}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {request.learnerEmail}
              </span>
            </p>
            <Link
              to={`/courses/${request.courseSlug}`}
              className="text-sm hover:underline"
            >
              {request.courseTitle}
            </Link>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">{formatPrice(request.amountPaid)}</p>
            <p className="text-xs text-muted-foreground">
              Requested {formatDate(request.requestedAt)}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Purchased</dt>
            <dd>{formatDate(request.purchasedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Refund window</dt>
            <dd>
              Day {request.daysIntoWindow} of {REFUND_WINDOW_DAYS}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Watched</dt>
            <dd>
              {formatWatched(request.watchedSeconds)} of {MAX_WATCHED_HOURS}h
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">History</dt>
            <dd>
              {request.earlierDeclinedOnPurchase} declined here
              {request.earlierApprovedOnCourse > 0 &&
                `, ${request.earlierApprovedOnCourse} earlier approved on this course`}
            </dd>
          </div>
        </dl>

        <blockquote className="border-l-2 pl-3 text-sm italic">
          {request.reason}
        </blockquote>

        {(request.warnings.length > 0 || seatReason || ownPurchaseReason) && (
          <ul className="space-y-1 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            {[...request.warnings, seatReason, ownPurchaseReason]
              .filter(Boolean)
              .map((warning) => (
                <li key={warning} className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {warning}
                </li>
              ))}
          </ul>
        )}

        <div className="flex justify-end gap-2">
          <DecisionDialog
            request={request}
            decision="decline"
            disabledReason={ownPurchaseReason}
          />
          <DecisionDialog
            request={request}
            decision="approve"
            disabledReason={ownPurchaseReason ?? seatReason}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function DecidedRequestRow({ request }: { request: DecidedRequest }) {
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3 text-sm">
        <p className="font-medium">{request.learnerName}</p>
        <p className="text-xs text-muted-foreground">{request.courseTitle}</p>
      </td>
      <td className="px-4 py-3 text-sm">{formatPrice(request.amountPaid)}</td>
      <td className="px-4 py-3 text-sm">
        {formatDate(request.resolvedAt)}
        <p className="text-xs text-muted-foreground">
          by {request.decidedByName ?? "unknown"}
        </p>
      </td>
      <td className="max-w-sm px-4 py-3 text-sm">
        <p>{request.reason}</p>
        {request.decisionNote && (
          <p className="mt-1 text-xs text-muted-foreground">
            Note: {request.decisionNote}
          </p>
        )}
      </td>
    </tr>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { tab, adminId, open, decided } = loaderData;

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-6">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline learners&apos; Refund Requests. Decisions are final.
        </p>
      </div>

      <div className="mb-6 inline-flex rounded-lg bg-muted p-1">
        {TABS.map((t) => (
          <Link
            key={t.value}
            to={t.value === "open" ? "?" : `?tab=${t.value}`}
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium transition-colors",
              tab === t.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "open" ? (
        open.length === 0 ? (
          <EmptyState message="No Open Refund Requests. Nothing is waiting on you." />
        ) : (
          <div className="space-y-4">
            {open.map((request) => (
              <OpenRequestCard key={request.id} request={request} adminId={adminId} />
            ))}
          </div>
        )
      ) : decided.length === 0 ? (
        <EmptyState message={`No ${tab} Refund Requests yet.`} />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  {["Learner", "Amount", "Decided", "Reason"].map((heading) => (
                    <th
                      key={heading}
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {decided.map((request) => (
                  <DecidedRequestRow key={request.id} request={request} />
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-center">
        <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
        <p className="text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
