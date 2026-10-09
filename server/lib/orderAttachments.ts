import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { UPLOADS_DIR } from "./uploads.js";
import { isCloudinaryConfigured, safeUnlink, uploadAttachmentToCloudinary } from "./cloudinary.js";

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOADS_DIR),
  filename: (_req, file, callback) => callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
});

export const uploadOrderAttachment = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

export async function storeOrderAttachment(file: Express.Multer.File, uploadedBy: string) {
  let url = `/uploads/${file.filename}`;
  let cloudinaryPublicId = "";
  let cloudinaryResourceType = "";

  if (isCloudinaryConfigured) {
    try {
      const uploaded = await uploadAttachmentToCloudinary(file.path, file.originalname);
      url = uploaded.url;
      cloudinaryPublicId = uploaded.publicId;
      cloudinaryResourceType = uploaded.resourceType;
    } finally {
      safeUnlink(file.path);
    }
  }

  return {
    name: file.originalname,
    url,
    type: file.mimetype,
    size: file.size,
    cloudinaryPublicId,
    cloudinaryResourceType,
    uploadedBy,
    uploadedAt: new Date(),
  };
}
