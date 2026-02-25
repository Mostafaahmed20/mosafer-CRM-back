import { Response, NextFunction } from "express";
import { Board, BoardRole } from "../models/Board.js";
import { AuthRequest } from "./auth.js";
import { BOARD_ROLE_HIERARCHY, getBoardRole, isGlobalAdmin } from "../lib/accessControl.js";

export interface BoardAuthRequest extends AuthRequest {
  board?: any;
  boardRole?: BoardRole;
}

/**
 * Middleware factory that checks board membership and optionally
 * enforces a minimum role level. Global admins bypass board membership.
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

      if (isGlobalAdmin(req.user)) {
        req.board = board;
        req.boardRole = "admin";
        return next();
      }

      const members = board.members as any[];

      // Auto-migrate old member format (ObjectId[]) on access.
      if (!(members.length > 0 && members[0]?.user !== undefined)) {
        const isMember = members.some((m) => m.toString() === req.userId);
        if (isMember) {
          (board as any).members = members.map((m) => ({
            user: m,
            role: m.toString() === board.owner.toString() ? "admin" : "member",
          }));
          await board.save();
          console.log(`Auto-migrated board "${board.title}" to new member format`);
        }
      }

      const memberRole = getBoardRole(board, req.userId!);
      if (!memberRole) {
        return res.status(403).json({ message: "You are not a member of this board" });
      }

      req.board = board;
      req.boardRole = memberRole;

      if (minRole) {
        const userLevel = BOARD_ROLE_HIERARCHY[memberRole] || 0;
        const requiredLevel = BOARD_ROLE_HIERARCHY[minRole] || 0;
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
