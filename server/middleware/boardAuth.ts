import { Response, NextFunction } from "express";
import { Board, BoardRole } from "../models/Board.js";
import { AuthRequest } from "./auth.js";

const ROLE_HIERARCHY: Record<BoardRole, number> = {
  admin: 4,
  member: 3,
  guest: 2,
  observer: 1,
};

export interface BoardAuthRequest extends AuthRequest {
  board?: any;
  boardRole?: BoardRole;
}

/**
 * Middleware factory that checks board membership and optionally
 * enforces a minimum role level.
 *
 * Usage:
 *   router.post("/", boardAuth("member"), handler)
 *   router.get("/", boardAuth(), handler)  // just loads board + role
 */
export function boardAuth(minRole?: BoardRole) {
  return async (req: BoardAuthRequest, res: Response, next: NextFunction) => {
    try {
      const boardId = req.params.boardId;
      if (!boardId) {
        return res.status(400).json({ message: "Board ID is required" });
      }

      const board = await Board.findById(boardId);
      if (!board) {
        return res.status(404).json({ message: "Board not found" });
      }

      // Handle both old format (ObjectId array) and new format (subdocument array)
      let memberEntry: any;
      const members = board.members as any[];

      // Check if it's the new format (has .user property) or old format (direct ObjectId)
      if (members.length > 0 && members[0].user !== undefined) {
        // New format: { user: ObjectId, role: string }
        memberEntry = members.find((m) => m.user.toString() === req.userId);
      } else {
        // Old format: just ObjectId - migrate on-the-fly
        const isMember = members.some((m) => m.toString() === req.userId);
        if (isMember) {
          // Auto-migrate to new format
          const isOwner = board.owner.toString() === req.userId;
          const newMembers = members.map((m) => ({
            user: m,
            role: m.toString() === board.owner.toString() ? "admin" : "member"
          }));
          (board as any).members = newMembers;
          await board.save();

          // Find the migrated member entry
          memberEntry = { user: req.userId, role: isOwner ? "admin" : "member" };
          console.log(`✅ Auto-migrated board "${board.title}" to new member format`);
        }
      }

      if (!memberEntry) {
        return res
          .status(403)
          .json({ message: "You are not a member of this board" });
      }

      const memberRole = (memberEntry.role || "member") as BoardRole;
      req.board = board;
      req.boardRole = memberRole;

      if (minRole) {
        const userLevel = ROLE_HIERARCHY[memberRole] || 0;
        const requiredLevel = ROLE_HIERARCHY[minRole] || 0;
        if (userLevel < requiredLevel) {
          return res.status(403).json({
            message: `This action requires "${minRole}" role or higher`,
          });
        }
      }

      next();
    } catch (error) {
      console.error("Board auth error:", error);
      res.status(500).json({ message: "Server error" });
    }
  };
}
