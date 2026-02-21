import { Server as SocketServer } from "socket.io";
import { Server } from "http";
import jwt from "jsonwebtoken";
import { env } from "./config/env.js";

const JWT_SECRET = env.JWT_SECRET;

export function setupSocket(server: Server) {
  const io = new SocketServer(server, {
    cors: {
      origin: env.CORS_ORIGINS,
      methods: ["GET", "POST"],
    },
  });

  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error("Authentication error"));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
      socket.data.userId = decoded.userId;
      next();
    } catch (err) {
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
