import { Server as SocketServer } from "socket.io";
import { Server } from "http";
import jwt from "jsonwebtoken";
import { env } from "./config/env.js";
import { isAllowedCorsOrigin } from "./lib/cors.js";

const JWT_SECRET = env.JWT_SECRET;

function normalizeToken(raw?: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("Bearer ") ? trimmed.slice(7).trim() : trimmed;
}

function getHandshakeToken(socket: Parameters<SocketServer["use"]>[0] extends (socket: infer S, next: any) => any ? S : never) {
  const auth = socket.handshake.auth as
    | { token?: unknown; accessToken?: unknown; Authorization?: unknown }
    | undefined;
  const authHeader = socket.handshake.headers?.authorization;
  const queryToken = socket.handshake.query?.token;

  return (
    normalizeToken(auth?.token) ??
    normalizeToken(auth?.accessToken) ??
    normalizeToken(auth?.Authorization) ??
    normalizeToken(Array.isArray(authHeader) ? authHeader[0] : authHeader) ??
    normalizeToken(Array.isArray(queryToken) ? queryToken[0] : queryToken)
  );
}

export function setupSocket(server: Server) {
  const io = new SocketServer(server, {
    cors: {
      origin(origin, callback) {
        if (!origin || isAllowedCorsOrigin(origin, env.CORS_ORIGINS, !env.IS_PROD)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS blocked"));
      },
      methods: ["GET", "POST"],
    },
  });

  // Authentication middleware
  io.use((socket, next) => {
    const token = getHandshakeToken(socket);
    if (!token) {
      console.warn("[Socket.IO] Missing auth token during handshake");
      return next(new Error("Authentication error"));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
      socket.data.userId = decoded.userId;
      next();
    } catch (err) {
      console.warn("[Socket.IO] Invalid auth token during handshake");
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`🔌 User connected: ${socket.data.userId}`);
    // Join personal room for user-wide events (notifications)
    if (socket.data.userId) {
      socket.join(`user:${socket.data.userId}`);
    }

    // Join a board room
    socket.on("join-board", (boardId: string) => {
      socket.join(`board:${boardId}`);
      console.log(`📋 User ${socket.data.userId} joined board ${boardId}`);
    });

    // Leave a board room
    socket.on("leave-board", (boardId: string) => {
      socket.leave(`board:${boardId}`);
      console.log(`📋 User ${socket.data.userId} left board ${boardId}`);
    });

    socket.on("disconnect", () => {
      console.log(`🔌 User disconnected: ${socket.data.userId}`);
    });
  });

  return io;
}

// Export a singleton instance that will be set during server startup
let ioInstance: SocketServer | null = null;

export function setSocketInstance(io: SocketServer) {
  ioInstance = io;
}

export function getSocketInstance(): SocketServer {
  if (!ioInstance) {
    throw new Error("Socket.IO instance not initialized");
  }
  return ioInstance;
}
