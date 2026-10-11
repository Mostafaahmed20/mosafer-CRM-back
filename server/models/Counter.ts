import mongoose from "mongoose";

export interface ICounter {
  _id: string;
  sequence: number;
}

const counterSchema = new mongoose.Schema<ICounter>(
  {
    _id: { type: String, required: true },
    sequence: { type: Number, required: true, min: 0 },
  },
  { versionKey: false }
);

export const Counter = mongoose.model<ICounter>("Counter", counterSchema);

/** Generates a short, monotonically increasing reservation reference. */
export async function nextReservationReference(): Promise<string> {
  try {
    await Counter.updateOne(
      { _id: "reservation" },
      { $setOnInsert: { sequence: 61541 } },
      { upsert: true }
    );
  } catch (error: any) {
    // Another request may initialize the counter concurrently; continue to its atomic increment.
    if (error?.code !== 11000) throw error;
  }

  const counter = await Counter.findOneAndUpdate(
    { _id: "reservation" },
    { $inc: { sequence: 1 } },
    { new: true }
  );
  if (!counter) throw new Error("Unable to allocate reservation reference");
  return String(counter.sequence);
}
