import mongoose from "mongoose";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

export async function connectDB() {
  try {
    await mongoose.connect(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    });
    logger.info("Connected to MongoDB");
  } catch (error) {
    logger.fatal({ err: error }, "MongoDB connection error");
    process.exit(1);
  }
}
