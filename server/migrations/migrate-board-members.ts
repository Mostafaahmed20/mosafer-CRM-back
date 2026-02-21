import "dotenv/config";
import { Board } from "../models/Board.js";
import { connectDB } from "../db.js";

/**
 * Migration script to convert old board members format to new RBAC format.
 *
 * Old format: members: [ObjectId, ObjectId, ...]
 * New format: members: [{ user: ObjectId, role: "admin" | "member" | ... }, ...]
 *
 * This script:
 * 1. Finds boards with old format members
 * 2. Converts owner to admin role
 * 3. Converts other members to member role
 */

async function migrateBoardMembers() {
  try {
    console.log("🔄 Starting board members migration...");

    // Find all boards
    const boards = await Board.find({});
    console.log(`Found ${boards.length} boards to check`);

    let migratedCount = 0;
    let skippedCount = 0;

    for (const board of boards) {
      // Check if members array needs migration
      // Old format: members is array of ObjectIds
      // New format: members is array of objects with user and role

      if (board.members.length === 0) {
        // Empty members - add owner as admin
        (board.members as any) = [
          {
            user: board.owner,
            role: "admin",
          },
        ];
        await board.save();
        migratedCount++;
        console.log(`✅ Migrated board "${board.title}" (empty members -> added owner as admin)`);
        continue;
      }

      // Check if first member has the old format (is ObjectId instead of object)
      const firstMember = board.members[0] as any;

      // If it's already in the new format, skip
      if (firstMember.user !== undefined && firstMember.role !== undefined) {
        skippedCount++;
        continue;
      }

      // Old format detected - migrate
      const oldMembers = board.members as any[];
      const newMembers: any[] = [];

      // Add owner as admin
      const ownerExists = oldMembers.some(
        (m) => m.toString() === board.owner.toString()
      );

      if (!ownerExists) {
        newMembers.push({
          user: board.owner,
          role: "admin",
        });
      } else {
        // Owner is in members, make them admin
        newMembers.push({
          user: board.owner,
          role: "admin",
        });
      }

      // Add other members as "member" role
      for (const memberId of oldMembers) {
        if (memberId.toString() !== board.owner.toString()) {
          newMembers.push({
            user: memberId,
            role: "member",
          });
        }
      }

      // Update the board
      (board.members as any) = newMembers;
      await board.save();
      migratedCount++;
      console.log(`✅ Migrated board "${board.title}" (${oldMembers.length} members -> ${newMembers.length} members)`);
    }

    console.log("\n📊 Migration Summary:");
    console.log(`   Total boards: ${boards.length}`);
    console.log(`   Migrated: ${migratedCount}`);
    console.log(`   Skipped (already migrated): ${skippedCount}`);
    console.log("\n✨ Migration completed successfully!");

    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

// Connect to MongoDB and run migration
connectDB()
  .then(() => migrateBoardMembers())
  .catch((error: any) => {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  });
