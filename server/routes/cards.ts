import { Router, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { CARD_STATUSES, Card } from "../models/Card.js";
import { List } from "../models/List.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { Board } from "../models/Board.js";
import { authMiddleware, requireVerifiedEmail } from "../middleware/auth.js";
import { boardAuth, BoardAuthRequest } from "../middleware/boardAuth.js";
import { getSocketInstance } from "../socket.js";
import { recordActivity } from "../lib/activity.js";
import { emitNotifications } from "../lib/notify.js";
import { ensureCardSla, deriveSlaStatus, computeSlaDue } from "../lib/sla.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.resolve(__dirname, "..", "..", "uploads");

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const router = Router({ mergeParams: true });

router.use(authMiddleware, requireVerifiedEmail);

const TERMINAL_CARD_STATUSES = new Set(["Completed", "Cancelled", "Closed"]);

function canTransitionCardStatus(currentStatus: string, nextStatus: string): boolean {
  if (currentStatus === nextStatus) return true;
  if (TERMINAL_CARD_STATUSES.has(currentStatus)) return false;
  // Allow direct cancellation from any non-terminal status.
  if (nextStatus === "Cancelled") return true;
  return CARD_STATUSES.includes(nextStatus as (typeof CARD_STATUSES)[number]);
}

function readEffectiveString(
  updateData: Record<string, unknown>,
  key: string,
  fallback: unknown
): string {
  if (typeof updateData[key] === "string") return String(updateData[key]).trim();
  return String(fallback || "").trim();
}

function validateStatusRequirements(
  nextStatus: string,
  updateData: Record<string, unknown>,
  existingCard: any
): string | null {
  const supplierConf = readEffectiveString(
    updateData,
    "supplierConfirmationNumber",
    existingCard.supplierConfirmationNumber
  );
  const hotelConf = readEffectiveString(
    updateData,
    "hotelConfirmationNumber",
    existingCard.hotelConfirmationNumber
  );
  const voucher = readEffectiveString(updateData, "voucherNumber", existingCard.voucherNumber);
  const paymentStatus = readEffectiveString(updateData, "paymentStatus", existingCard.paymentStatus);

  if ((nextStatus === "Confirmed" || nextStatus === "Reconfirmed") && !supplierConf) {
    return "Supplier confirmation number is required before confirming the booking";
  }
  if (nextStatus === "In-house" && !hotelConf) {
    return "Hotel confirmation number is required before moving to In-house";
  }
  if (nextStatus === "Completed") {
    if (!voucher) return "Voucher number is required before completing the case";
    if (paymentStatus !== "Paid" && paymentStatus !== "Not required") {
      return "Payment status must be Paid or Not required before completing the case";
    }
  }
  return null;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldAutoGenerateCaseRef(source?: string): boolean {
  const normalized = String(source || "").toLowerCase().replace(/\s+/g, "");
  return (
    normalized === "email" ||
    normalized === "whatsapp" ||
    normalized === "whatsup" ||
    normalized === "wa"
  );
}

async function generateCaseReference(): Promise<string> {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `REQ-${datePart}`;
  const regex = new RegExp(`^${escapeRegExp(prefix)}-\\d{4}$`);

  const existing = await Card.countDocuments({
    bookingRef: { $regex: regex },
  });
  const nextSerial = String(existing + 1).padStart(4, "0");
  return `${prefix}-${nextSerial}`;
}

// POST /api/boards/:boardId/lists/:listId/cards - Create a card
router.post("/", boardAuth("guest"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const listId = req.params.listId as string;
    const boardId = req.params.boardId as string;
    const { title, description, bookingRef, agencyName, hotelName, source } = req.body;

    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }

    const position = await Card.countDocuments({ list: listId });
    const creator = await User.findById(req.userId);

    let nextBookingRef = String(bookingRef || "").trim();
    const nextSource = String(source || "Agency").trim();
    if (!nextBookingRef && shouldAutoGenerateCaseRef(nextSource)) {
      nextBookingRef = await generateCaseReference();
      req.log?.info(
        { event: "case.ref.generated", boardId, listId, bookingRef: nextBookingRef, source: nextSource },
        "Auto-generated case reference"
      );
    }

    const card = new Card({
      title,
      subject: title,
      requester: creator?.username || creator?.email || "",
      bookingRef: nextBookingRef,
      agencyName: agencyName || "",
      hotelName: hotelName || "",
      status: "New",
      source: nextSource,
      description: description || "",
      list: listId,
      creator: req.userId,
      position,
      slaType: req.body.slaType || "first_response",
      slaStartedAt: new Date(),
      slaDueAt: null,
      slaStatus: "Open",
    });

    await ensureCardSla(card);
    await card.save();
    await card.populate("creator", "username email");
    await card.populate("agent", "username email");
    await card.populate("members", "username email");
    await card.populate("comments.author", "username email");

    // Emit real-time update
    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("card:created", { card, listId, userId: req.userId });
      console.log(`🔄 Broadcasted card creation to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    await recordActivity({
      boardId,
      actorId: req.userId as string,
      type: "card_created",
      message: `Created card "${card.title}"`,
      listId: listId,
      cardId: card._id.toString(),
      notifyMembers: true,
    });

    res.status(201).json(card);
  } catch (error) {
    console.error("Create card error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /api/boards/:boardId/lists/:listId/cards/:cardId - Get card by ID
router.get("/:cardId", boardAuth(), async (req: BoardAuthRequest, res: Response) => {
  try {
    const card = await Card.findById(req.params.cardId)
      .populate("creator", "username email")
      .populate("agent", "username email")
      .populate("members", "username email")
      .populate("comments.author", "username email");

    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    res.json(card);
  } catch (error) {
    console.error("Get card error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/boards/:boardId/lists/:listId/cards/:cardId - Update a card
router.patch("/:cardId", boardAuth("guest"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const boardId = req.params.boardId as string;
    const listId = req.params.listId as string;
    const existingCard = await Card.findById(req.params.cardId);
    if (!existingCard) {
      return res.status(404).json({ message: "Card not found" });
    }

    // Guest role check: can only edit cards they're assigned to
    if (req.boardRole === "guest") {
      const isAssigned = existingCard.members.some(
        (m) => m.toString() === req.userId
      );
      if (!isAssigned) {
        return res
          .status(403)
          .json({ message: "Guests can only edit cards they are assigned to" });
      }
    }

    const updateData: Record<string, unknown> = { ...req.body };
    const previousStatus = existingCard.status || "New";
    const previousAgentId = existingCard.agent ? existingCard.agent.toString() : "";
    const previousMemberIds = new Set((existingCard.members || []).map((m: any) => m.toString()));
    if (typeof updateData.status === "string") {
      const nextStatus = updateData.status;
      if (!CARD_STATUSES.includes(nextStatus as (typeof CARD_STATUSES)[number])) {
        return res.status(400).json({ message: `Invalid status "${nextStatus}"` });
      }
      if (!canTransitionCardStatus(existingCard.status || "New", nextStatus)) {
        return res.status(400).json({
          message: `Cannot transition from "${existingCard.status}" to "${nextStatus}"`,
        });
      }
      const requirementError = validateStatusRequirements(nextStatus, updateData, existingCard);
      if (requirementError) {
        return res.status(400).json({ message: requirementError });
      }
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "dueDate")) {
      updateData.dueReminder24hSent = false;
      updateData.dueReminder24hSentAt = null;
      updateData.dueReminder1hSent = false;
      updateData.dueReminder1hSentAt = null;
      updateData.dueReminderDueSent = false;
      updateData.dueReminderDueSentAt = null;
    }
    if (
      Object.prototype.hasOwnProperty.call(updateData, "arrivalDate") ||
      Object.prototype.hasOwnProperty.call(updateData, "checkInDate")
    ) {
      updateData.arrivalReminder3dSent = false;
      updateData.arrivalReminder3dSentAt = null;
      updateData.arrivalReminder1dSent = false;
      updateData.arrivalReminder1dSentAt = null;
      updateData.confirmationEscalationSent = false;
      updateData.confirmationEscalationSentAt = null;
    }
    if (
      Object.prototype.hasOwnProperty.call(updateData, "supplierConfirmationNumber") ||
      Object.prototype.hasOwnProperty.call(updateData, "hotelConfirmationNumber") ||
      Object.prototype.hasOwnProperty.call(updateData, "status")
    ) {
      updateData.confirmationEscalationSent = false;
      updateData.confirmationEscalationSentAt = null;
    }

    const handoverKeys = [
      "handoverStatus",
      "handoverSummary",
      "handoverDone",
      "handoverPending",
      "handoverPendingState",
      "handoverBlocker",
      "handoverNextAction",
      "handoverNextOwner",
    ];
    const hasHandoverUpdate = handoverKeys.some((key) =>
      Object.prototype.hasOwnProperty.call(updateData, key)
    );
    if (hasHandoverUpdate) {
      if (Object.prototype.hasOwnProperty.call(updateData, "handoverPendingState")) {
        const pendingState = String(updateData.handoverPendingState || "No");
        if (pendingState !== "Yes" && pendingState !== "No") {
          return res.status(400).json({ message: 'Pending must be "Yes" or "No"' });
        }
      }

      if (Object.prototype.hasOwnProperty.call(updateData, "handoverNextOwner")) {
        const rawNextOwner = updateData.handoverNextOwner;
        const nextOwnerId = String(rawNextOwner || "").trim();
        if (!nextOwnerId) {
          updateData.handoverNextOwner = "";
        } else {
          if (!/^[a-fA-F0-9]{24}$/.test(nextOwnerId)) {
            return res.status(400).json({ message: "Invalid next owner" });
          }
          const board = await Board.findById(boardId).select("owner members");
          const ownerId = board?.owner ? String(board.owner) : "";
          const isBoardMember = Boolean(
            board &&
              (ownerId === nextOwnerId ||
                (board.members || []).some((m: any) => String(m.user) === nextOwnerId))
          );
          if (!isBoardMember) {
            return res.status(400).json({ message: "Next owner must be a board member" });
          }
          updateData.handoverNextOwner = nextOwnerId;
        }
      }

      updateData.handoverUpdatedAt = new Date();
      updateData.handoverUpdatedBy = req.userId as string;
      updateData.handoverReminderSentAt = null;
      updateData.handoverReminderCount = 0;
    }

    const explicitBookingRef = String(updateData.bookingRef || "").trim();
    const targetSource =
      typeof updateData.source === "string" ? String(updateData.source) : String(existingCard.source || "");
    const targetAgency =
      typeof updateData.agencyName === "string"
        ? String(updateData.agencyName)
        : String(existingCard.agencyName || "");
    if (!explicitBookingRef && !String(existingCard.bookingRef || "").trim() && shouldAutoGenerateCaseRef(targetSource)) {
      updateData.bookingRef = await generateCaseReference();
      req.log?.info(
        {
          event: "case.ref.generated",
          boardId,
          cardId: existingCard._id.toString(),
          bookingRef: updateData.bookingRef,
          source: targetSource,
        },
        "Auto-generated case reference on update"
      );
    }

    const card = await Card.findByIdAndUpdate(req.params.cardId, updateData, {
      new: true,
    })
      .populate("creator", "username email")
      .populate("agent", "username email")
      .populate("members", "username email")
      .populate("comments.author", "username email");

    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    // Emit real-time update
    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("card:updated", { card, userId: req.userId });
      console.log(`🔄 Broadcasted card update to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    const updatedFields = Object.keys(req.body || {});
    const nextStatus = typeof req.body?.status === "string" ? req.body.status : previousStatus;
    const statusChanged = nextStatus !== previousStatus;
    const agentChanged = Object.prototype.hasOwnProperty.call(req.body || {}, "agent") &&
      (req.body.agent || "") !== previousAgentId;
    const membersChanged = Array.isArray(req.body?.members);
    const supplierConfChanged = Object.prototype.hasOwnProperty.call(req.body || {}, "supplierConfirmationNumber");
    const hotelConfChanged = Object.prototype.hasOwnProperty.call(req.body || {}, "hotelConfirmationNumber");

    let activityType = "card_updated";
    if (statusChanged && !agentChanged && !membersChanged) activityType = "card_status_changed";
    if (agentChanged || membersChanged) activityType = "card_assignment_changed";

    const details: string[] = [];
    if (statusChanged) {
      details.push(`status ${previousStatus} -> ${nextStatus}`);
    }

    if (agentChanged) {
      const oldAgentName = previousAgentId
        ? ((await User.findById(previousAgentId).select("username")) as any)?.username || "Unassigned"
        : "Unassigned";
      const newAgentId = req.body.agent ? String(req.body.agent) : "";
      const newAgentName = newAgentId
        ? ((await User.findById(newAgentId).select("username")) as any)?.username || "Unassigned"
        : "Unassigned";
      details.push(`agent ${oldAgentName} -> ${newAgentName}`);
    }

    if (membersChanged) {
      const nextMemberIds = new Set((req.body.members || []).map((m: any) => String(m)));
      const added = Array.from(nextMemberIds).filter((id) => !previousMemberIds.has(id)).length;
      const removed = Array.from(previousMemberIds).filter((id) => !nextMemberIds.has(id)).length;
      if (added > 0 || removed > 0) {
        details.push(`members +${added}/-${removed}`);
      }
    }

    if (statusChanged) {
      req.log?.info(
        {
          event: "ticket.status_changed",
          cardId: card._id.toString(),
          boardId,
          from: previousStatus,
          to: nextStatus,
        },
        "Ticket status changed"
      );
    }

    if (agentChanged || membersChanged) {
      req.log?.info(
        {
          event: "ticket.assignment_changed",
          cardId: card._id.toString(),
          boardId,
          agentChanged,
          membersChanged,
        },
        "Ticket assignment changed"
      );
    }

    if (supplierConfChanged || hotelConfChanged) {
      req.log?.info(
        {
          event: "booking.confirmation_updated",
          cardId: card._id.toString(),
          boardId,
          supplierConfChanged,
          hotelConfChanged,
        },
        "Booking confirmation fields updated"
      );
    }

    if (card) {
      if (typeof req.body?.type === "string") {
        card.slaType = req.body.type;
        card.slaDueAt = computeSlaDue(req.body.type, card.slaStartedAt || card.createdAt) || undefined;
      }
      card.slaStatus = deriveSlaStatus(card);
      await card.save();
    }

    const activityMessage = details.length > 0
      ? `Updated "${card.title}" (${details.join(", ")})`
      : updatedFields.includes("dueDate")
      ? `Updated due date for "${card.title}"`
      : `Updated card "${card.title}"`;

    await recordActivity({
      boardId,
      actorId: req.userId as string,
      type: activityType,
      message: activityMessage,
      listId: card.list.toString(),
      cardId: card._id.toString(),
      meta: { fields: updatedFields },
      notifyMembers: true,
    });

    res.json(card);
  } catch (error) {
    console.error("Update card error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/boards/:boardId/lists/:listId/cards/:cardId - Delete a card
router.delete("/:cardId", boardAuth("admin"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const boardId = req.params.boardId as string;
    const card = await Card.findById(req.params.cardId);
    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    const listId = card.list.toString();
    await Card.findByIdAndDelete(req.params.cardId);

    // Emit real-time update
    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("card:deleted", {
        cardId: req.params.cardId,
        listId,
        userId: req.userId,
      });
      console.log(`🔄 Broadcasted card deletion to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    await recordActivity({
      boardId,
      actorId: req.userId as string,
      type: "card_deleted",
      message: `Deleted card "${card.title}"`,
      listId,
      cardId: card._id.toString(),
      notifyMembers: true,
    });

    res.json({ message: "Card deleted" });
  } catch (error) {
    console.error("Delete card error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/boards/:boardId/lists/:listId/cards/reorder - Reorder / move cards
router.post("/reorder", boardAuth("member"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const boardId = req.params.boardId as string;
    const listId = req.params.listId as string;
    const { cardId, newPosition, newListId } = req.body;

    if (!cardId || newPosition === undefined) {
      return res
        .status(400)
        .json({ message: "cardId and newPosition are required" });
    }

    const card = await Card.findById(cardId);
    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    const oldListId = card.list.toString();
    const targetListId = newListId || oldListId;

    // Validate target list exists and belongs to this board
    if (targetListId !== oldListId) {
      const targetList = await List.findById(targetListId);
      if (!targetList || targetList.board.toString() !== boardId) {
        return res.status(400).json({ message: "Invalid target list" });
      }
    }

    if (targetListId !== oldListId) {
      // Moving to a different list
      // Decrement positions in old list for cards after the moved card
      await Card.updateMany(
        { list: oldListId, position: { $gt: card.position } },
        { $inc: { position: -1 } }
      );

      // Increment positions in new list for cards at/after the target position
      await Card.updateMany(
        { list: targetListId, position: { $gte: newPosition } },
        { $inc: { position: 1 } }
      );

      card.list = targetListId as any;
      card.position = newPosition;
      await card.save();
      console.log(`✅ Card "${card.title}" moved from list ${oldListId} → ${targetListId} (position: ${newPosition})`);
    } else {
      // Reorder within same list
      const oldPosition = card.position;

      if (oldPosition < newPosition) {
        await Card.updateMany(
          {
            list: oldListId,
            position: { $gt: oldPosition, $lte: newPosition },
          },
          { $inc: { position: -1 } }
        );
      } else if (oldPosition > newPosition) {
        await Card.updateMany(
          {
            list: oldListId,
            position: { $gte: newPosition, $lt: oldPosition },
          },
          { $inc: { position: 1 } }
        );
      }

      card.position = newPosition;
      await card.save();
    }

    // Emit real-time update to all users viewing the board
    try {
      const io = getSocketInstance();
      io.to(`board:${boardId}`).emit("card:moved", {
        cardId: card._id,
        oldListId,
        newListId: targetListId,
        newPosition,
        userId: req.userId,
      });
      console.log(`🔄 Broadcasted card move to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    await recordActivity({
      boardId,
      actorId: req.userId as string,
      type: targetListId !== oldListId ? "card_moved" : "card_reordered",
      message:
        targetListId !== oldListId
          ? `Moved card "${card.title}" to another list`
          : `Reordered card "${card.title}"`,
      listId: targetListId,
      cardId: card._id.toString(),
      meta: { oldListId, newListId: targetListId, newPosition },
      notifyMembers: targetListId === oldListId,
    });

    // Create notifications when card moves between lists
    if (targetListId !== oldListId) {
      try {
        const currentUser = await User.findById(req.userId);
        const [oldList, newList] = await Promise.all([
          List.findById(oldListId),
          List.findById(targetListId),
        ]);
        const boardWithMembers = await Board.findById(boardId).populate("members.user", "username email");

        if (boardWithMembers && oldList && newList) {
          const recipients: string[] = [];
          boardWithMembers.members.forEach((member: any) => {
            const userId = member.user?._id ? member.user._id.toString() : member.user?.toString();
            if (userId && userId !== req.userId) {
              recipients.push(userId);
            }
          });

          const notifications = recipients.map((recipientId) => ({
            recipient: recipientId,
            sender: req.userId,
            type: "card_moved" as const,
            card: card._id,
            board: boardWithMembers._id,
            message: `${currentUser?.username} moved "${card.title}" from "${oldList.title}" to "${newList.title}"`,
            read: false,
          }));

          if (notifications.length > 0) {
            await Notification.insertMany(notifications);
            emitNotifications(
              notifications.map((n) => ({
                recipient: n.recipient,
                message: n.message,
                type: n.type,
                card: n.card,
                board: n.board,
              }))
            );
            console.log(`✉️ Created ${notifications.length} move notification(s) for card "${card.title}"`);
          }
        }
      } catch (notifError) {
        console.error("Failed to create move notifications:", notifError);
      }
    }

    res.json({ message: "Card reordered" });
  } catch (error) {
    console.error("Reorder card error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/boards/:boardId/lists/:listId/cards/:cardId/comments - Add comment
router.post("/:cardId/comments", boardAuth("guest"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ message: "Comment text is required" });
    }

    const card = await Card.findById(req.params.cardId);
    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    card.comments.push({
      text,
      author: req.userId as any,
      createdAt: new Date(),
    });

    await card.save();
    await card.populate("creator", "username email");
    await card.populate("agent", "username email");
    await card.populate("comments.author", "username email");
    await card.populate("members", "username email");

    // Create notifications for board members and mentions
    try {
      const currentUser = await User.findById(req.userId);

      if (!req.board) {
        throw new Error("Board not available");
      }

      const boardWithMembers = await Board.findById(req.board._id).populate("members.user", "username email");
      if (!boardWithMembers) throw new Error("Board not found");

      const members = boardWithMembers.members || [];
      const usernameMap: Record<string, string> = {};
      members.forEach((m: any) => {
        const u = m.user;
        if (u?.username) usernameMap[u.username.toLowerCase()] = u._id.toString();
      });

      // Extract @mentions in a forgiving way: split on whitespace, trim punctuation.
      const mentionIds = new Set<string>();
      const tokens = text.split(/\s+/);
      tokens.forEach((t: string) => {
        if (!t.startsWith("@") || t.length < 2) return;
        const raw = t.slice(1).replace(/[.,!?;:)\]]+$/, "");
        const username = raw.toLowerCase();
        const uid = usernameMap[username];
        if (uid && uid !== req.userId) mentionIds.add(uid);
      });

      // Recipients for generic comment (exclude mentions to avoid double)
      const commentRecipients: string[] = [];
      members.forEach((member: any) => {
        const userId = member.user?._id?.toString();
        if (!userId || userId === req.userId) return;
        if (mentionIds.has(userId)) return;
        commentRecipients.push(userId);
      });

      const notifications: any[] = [];

      commentRecipients.forEach((recipientId) => {
        notifications.push({
          recipient: recipientId,
          sender: req.userId,
          type: "comment" as const,
          card: card._id,
          board: boardWithMembers._id,
          message: `${currentUser?.username} commented on "${card.title}"`,
          commentText: text,
          read: false,
        });
      });

      mentionIds.forEach((recipientId) => {
        notifications.push({
          recipient: recipientId,
          sender: req.userId,
          type: "mention" as const,
          card: card._id,
          board: boardWithMembers._id,
          message: `${currentUser?.username} mentioned you in "${card.title}"`,
          commentText: text,
          read: false,
        });
      });

      if (notifications.length > 0) {
        await Notification.insertMany(notifications);
        emitNotifications(
          notifications.map((n) => ({
            recipient: n.recipient,
            message: n.message,
            type: n.type,
            card: n.card,
            board: n.board,
            commentText: n.commentText,
          }))
        );
      }
    } catch (notifError) {
      console.error("Failed to create notifications:", notifError);
    }

    // Emit real-time update for comment
    try {
      const io = getSocketInstance();
      const boardId = req.params.boardId as string;
      io.to(`board:${boardId}`).emit("card:updated", { card, userId: req.userId });
      console.log(`🔄 Broadcasted comment update to board:${boardId}`);
    } catch (socketError) {
      console.error("Socket broadcast error:", socketError);
    }

    await recordActivity({
      boardId: req.params.boardId as string,
      actorId: req.userId as string,
      type: "comment_added",
      message: `Commented on "${card.title}"`,
      listId: card.list.toString(),
      cardId: card._id.toString(),
    });

    res.json(card);
  } catch (error) {
    console.error("Add comment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH /api/boards/:boardId/lists/:listId/cards/:cardId/comments/:commentId - Edit comment
router.patch("/:cardId/comments/:commentId", boardAuth("guest"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ message: "Comment text is required" });
    }

    const card = await Card.findById(req.params.cardId);
    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    const comment = (card.comments as any).id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    // Guest role check: can only edit own comments
    if (req.boardRole === "guest") {
      if (comment.author.toString() !== req.userId) {
        return res
          .status(403)
          .json({ message: "Guests can only edit their own comments" });
      }
    }

    comment.text = text;
    await card.save();
    await card.populate("creator", "username email");
    await card.populate("agent", "username email");
    await card.populate("comments.author", "username email");
    await card.populate("members", "username email");

    res.json(card);
  } catch (error) {
    console.error("Edit comment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /api/boards/:boardId/lists/:listId/cards/:cardId/comments/:commentId - Delete comment
router.delete("/:cardId/comments/:commentId", boardAuth("guest"), async (req: BoardAuthRequest, res: Response) => {
  try {
    const card = await Card.findById(req.params.cardId);
    if (!card) {
      return res.status(404).json({ message: "Card not found" });
    }

    const comment = (card.comments as any).id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ message: "Comment not found" });
    }

    // Guest role check: can only delete own comments
    if (req.boardRole === "guest") {
      if (comment.author.toString() !== req.userId) {
        return res
          .status(403)
          .json({ message: "Guests can only delete their own comments" });
      }
    }

    (card.comments as any).pull(req.params.commentId);
    await card.save();
    await card.populate("creator", "username email");
    await card.populate("agent", "username email");
    await card.populate("comments.author", "username email");
    await card.populate("members", "username email");

    res.json(card);
  } catch (error) {
    console.error("Delete comment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /api/boards/:boardId/lists/:listId/cards/:cardId/attachments - Upload attachment
router.post(
  "/:cardId/attachments",
  boardAuth("guest"),
  upload.single("file"),
  async (req: BoardAuthRequest, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const card = await Card.findById(req.params.cardId);
      if (!card) {
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        return res.status(404).json({ message: "Card not found" });
      }

      card.attachments.push({
        name: req.file.originalname,
        url: `/uploads/${req.file.filename}`,
        type: req.file.mimetype,
      });

      await card.save();
      await card.populate("creator", "username email");
      await card.populate("agent", "username email");
      await card.populate("members", "username email");
      await card.populate("comments.author", "username email");

      res.json(card);
    } catch (error) {
      console.error("Upload attachment error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// DELETE /api/boards/:boardId/lists/:listId/cards/:cardId/attachments/:attachmentId
router.delete(
  "/:cardId/attachments/:attachmentId",
  boardAuth("member"),
  async (req: BoardAuthRequest, res: Response) => {
    try {
      const card = await Card.findById(req.params.cardId);
      if (!card) {
        return res.status(404).json({ message: "Card not found" });
      }

      const attachment = (card.attachments as any).id(req.params.attachmentId);
      if (!attachment) {
        return res.status(404).json({ message: "Attachment not found" });
      }

      // Delete file from disk
      const filePath = path.join(UPLOADS_DIR, path.basename(attachment.url));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      (card.attachments as any).pull(req.params.attachmentId);
      await card.save();
      await card.populate("creator", "username email");
      await card.populate("agent", "username email");
      await card.populate("members", "username email");
      await card.populate("comments.author", "username email");

      res.json(card);
    } catch (error) {
      console.error("Delete attachment error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;
