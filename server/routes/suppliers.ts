import { Response, Router } from "express";
import { Supplier, SUPPLIER_TYPES } from "../models/Supplier.js";
import { AuthRequest, authMiddleware, requireVerifiedEmail, requireWorkflowRole } from "../middleware/auth.js";

const router = Router();
router.use(authMiddleware, requireVerifiedEmail);
const allowed = ["name", "type", "status", "country", "email", "phone", "whatsapp", "website", "currency", "paymentTerms", "contacts", "notes"];
const dataFrom = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));

function valid(data: Record<string, unknown>) {
  if (data.type && !SUPPLIER_TYPES.includes(data.type as any)) return "Invalid supplier type";
  if (data.currency && !/^[A-Za-z]{3}$/.test(String(data.currency))) return "Currency must be a three-letter code";
  if (data.contacts && (!Array.isArray(data.contacts) || data.contacts.some((contact: any) => !String(contact?.name || "").trim()))) return "Every contact needs a name";
  return null;
}

router.get("/", async (req: AuthRequest, res: Response) => {
  const query = String(req.query.q || "").trim();
  const filter: any = { owner: req.userId };
  if (query) filter.$or = [{ name: { $regex: query, $options: "i" } }, { country: { $regex: query, $options: "i" } }, { type: { $regex: query, $options: "i" } }];
  res.json(await Supplier.find(filter).sort({ status: 1, name: 1 }));
});

router.post("/", requireWorkflowRole("operations"), async (req: AuthRequest, res: Response) => {
  const data = dataFrom(req.body || {});
  if (!String(data.name || "").trim() || !data.type) return res.status(400).json({ message: "Supplier name and type are required" });
  const error = valid(data); if (error) return res.status(400).json({ message: error });
  try { res.status(201).json(await Supplier.create({ ...data, name: String(data.name).trim(), owner: req.userId })); }
  catch (err: any) { if (err?.code === 11000) return res.status(409).json({ message: "A supplier with this name already exists" }); throw err; }
});

router.patch("/:id", requireWorkflowRole("operations"), async (req: AuthRequest, res: Response) => {
  const data = dataFrom(req.body || {}); const error = valid(data); if (error) return res.status(400).json({ message: error });
  const supplier = await Supplier.findOneAndUpdate({ _id: req.params.id, owner: req.userId }, data, { new: true, runValidators: true });
  if (!supplier) return res.status(404).json({ message: "Supplier not found" }); res.json(supplier);
});

router.delete("/:id", requireWorkflowRole("operations"), async (req: AuthRequest, res: Response) => {
  const supplier = await Supplier.findOneAndDelete({ _id: req.params.id, owner: req.userId });
  if (!supplier) return res.status(404).json({ message: "Supplier not found" }); res.status(204).send();
});

export default router;
