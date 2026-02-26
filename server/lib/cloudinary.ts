import fs from "node:fs";
import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env.js";

export const isCloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export type UploadedCloudinaryAttachment = {
  url: string;
  publicId: string;
  resourceType: string;
};

export async function uploadAttachmentToCloudinary(
  filePath: string,
  originalName: string
): Promise<UploadedCloudinaryAttachment> {
  if (!isCloudinaryConfigured) {
    throw new Error("Cloudinary is not configured");
  }

  const result = await cloudinary.uploader.upload(filePath, {
    folder: env.CLOUDINARY_FOLDER,
    resource_type: "auto",
    use_filename: true,
    unique_filename: true,
    filename_override: originalName,
  });

  return {
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type,
  };
}

export async function deleteCloudinaryAttachment(publicId: string, resourceType = "image") {
  if (!isCloudinaryConfigured || !publicId) return;

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType as any });
  } catch {
    // Do not block card updates/deletes on remote file cleanup failures.
  }
}

export function safeUnlink(filePath?: string | null) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors.
  }
}
