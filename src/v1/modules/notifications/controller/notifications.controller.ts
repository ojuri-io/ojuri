import { FastifyReply, FastifyRequest } from "fastify";
import httpStatus from "http-status";
import { injectable } from "tsyringe";
import UserRepo from "@shared/authz/repositories/user.repo";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";

@injectable()
class NotificationsController {
  constructor(private readonly users: UserRepo) {}

  // POST /v1/notifications/seen — stamps the authenticated user's
  // `lastNotificationSeenAt` to now. The dashboard's bell popover calls
  // this on open; the next `computeNotifications` pass on the client
  // filters out items whose source event is older than the returned
  // timestamp, dropping the unread badge to zero until something new
  // arrives. Items themselves still render in the popover because they
  // represent active backlog (pending DECLINEs etc.), not transient
  // toasts. Idempotent: repeat opens just stamp the latest now().
  seen = async (req: FastifyRequest, res: FastifyReply) => {
    const subject = req.auth;
    if (!subject) {
      return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse("Not authenticated"));
    }

    const seenAt = await this.users.markNotificationsSeen(subject.userId);
    return res.send(
      SuccessResponse("Notifications marked seen", {
        lastNotificationSeenAt: seenAt.toISOString(),
      })
    );
  };
}

export default NotificationsController;
