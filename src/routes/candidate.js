// src/routes/candidate.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const jwt = require("jsonwebtoken");

const router = express.Router();

const ROOT_DIR = path.join(__dirname, "..", "..");
const db = require(path.join(ROOT_DIR, "models"));
const { Candidate } = db;

/* ---------- helpers ---------- */
function normLevel(s) {
  const d = String(s || "").trim().toLowerCase();
  if (!d) return null;
  if (/(^|[^a-z])(elem|elementary)([^a-z]|$)/i.test(d)) return "Elementary";
  if (/(^|[^a-z])(jhs|junior\s*high)([^a-z]|$)/i.test(d)) return "JHS";
  if (/(^|[^a-z])(shs|senior\s*high)([^a-z]|$)/i.test(d)) return "SHS";
  if (/college|coll\.?/i.test(d)) return "College";
  if (d === "elementary") return "Elementary";
  if (d === "jhs") return "JHS";
  if (d === "shs") return "SHS";
  if (d === "college") return "College";
  return null;
}
function readTokenFromReq(req) {
  const c = req.cookies?.token;
  if (c) return c;
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
function toYearString(v) {
  const s = (typeof v === "string" ? v : String(v ?? "")).trim();
  return s === "NaN" ? "" : s;
}
function withPhotoUrl(req, row) {
  const obj = row?.toJSON ? row.toJSON() : row;
  if (obj?.photoPath) obj.photoUrl = `${req.protocol}://${req.get("host")}${obj.photoPath}`;
  return obj;
}
function safeUnlink(relPath) {
  try {
    if (!relPath) return;
    const cleaned = String(relPath).replace(/^[\\/]/, "");
    const abs = path.join(ROOT_DIR, cleaned);
    fs.unlinkSync(abs);
  } catch {}
}
function requireAdmin(req, res, next) {
  try {
    const tok = readTokenFromReq(req);
    if (!tok || !process.env.JWT_SECRET) return res.status(403).json({ error: "Forbidden" });
    const u = jwt.verify(tok, process.env.JWT_SECRET);
    if ((u.role || "").toLowerCase() !== "admin") return res.status(403).json({ error: "Forbidden" });
    req.user = u;
    next();
  } catch { return res.status(403).json({ error: "Forbidden" }); }
}
function requireStudentOrAdmin(req, res, next) {
  try {
    const tok = readTokenFromReq(req);
    if (!tok || !process.env.JWT_SECRET) return res.status(401).json({ error: "Unauthorized" });
    const u = jwt.verify(tok, process.env.JWT_SECRET);
    const role = (u.role || "").toLowerCase();
    if (role !== "student" && role !== "admin") return res.status(403).json({ error: "Forbidden" });
    req.user = u;
    next();
  } catch { return res.status(401).json({ error: "Unauthorized" }); }
}

/* ---------- uploads ---------- */
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads", "candidates");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || "photo").replace(/[^\w.-]/g, "_");
    cb(null, `${Date.now()}-${safe.slice(-100)}`);
  },
});
const fileFilter = (_req, file, cb) => {
  if (file?.mimetype?.startsWith("image/")) return cb(null, true);
  cb(new Error("Only image uploads are allowed"));
};
const upload = multer({ storage, fileFilter });
function runUpload(req, res, next) {
  upload.single("photo")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

/* prefer createdAt; fall back to created_at; else id */
const createdField =
  Candidate?.rawAttributes?.createdAt
    ? "createdAt"
    : Candidate?.rawAttributes?.created_at
    ? "created_at"
    : "id";

/* ---------- ROUTES ---------- */

/* READ (student/admin) */
router.get("/", requireStudentOrAdmin, async (req, res) => {
  try {
    const role = (req.user?.role || "").toLowerCase();
    const dept = req.user?.department || null;

    const qLevel = normLevel(req.query.level);
    const where = {};

    if (role === "student") {
      const studentLvl = normLevel(dept);
      if (studentLvl) where.level = studentLvl;
      if (qLevel && studentLvl && qLevel !== studentLvl) return res.json([]);
    } else if (qLevel) {
      where.level = qLevel;
    }

    const rows = await Candidate.findAll({ where, order: [[createdField, "DESC"]] });
    res.json(rows.map((r) => withPhotoUrl(req, r)));
  } catch (e) {
    console.error("[CANDIDATE GET /]", e);
    res.status(500).json({ error: "Failed to fetch candidates" });
  }
});

/* READ (public, no auth) — safe fields only, no vote counts */
router.get("/public", async (req, res) => {
  try {
    const qLevel = normLevel(req.query.level);
    const where = qLevel ? { level: qLevel } : {};

    const rows = await Candidate.findAll({ where, order: [[createdField, "DESC"]] });
    res.json(
      rows.map((r) => {
        const c = withPhotoUrl(req, r);
        return {
          id: c.id,
          level: c.level,
          position: c.position,
          partyList: c.partyList,
          firstName: c.firstName,
          middleName: c.middleName,
          lastName: c.lastName,
          gender: c.gender,
          year: c.year,
          photoUrl: c.photoUrl,
        };
      })
    );
  } catch (e) {
    console.error("[CANDIDATE GET /public]", e);
    res.status(500).json({ error: "Failed to fetch candidates" });
  }
});

/* READ ONE (student/admin) */
router.get("/:id", requireStudentOrAdmin, async (req, res) => {
  try {
    const row = await Candidate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(withPhotoUrl(req, row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch candidate" });
  }
});

/* CREATE (admin only) */
router.post("/", requireAdmin, runUpload, async (req, res) => {
  try {
    const { level, position, partyList, firstName, middleName, lastName, gender, year } = req.body;

    const lvl = normLevel(level);
    if (!lvl) return res.status(400).json({ error: "Level is required (Elementary/JHS/SHS/College)." });

    const yearStr = toYearString(year);
    if (!yearStr) return res.status(400).json({ error: "Year is required." });
    if (/^\d+$/.test(yearStr)) {
      return res.status(400).json({
        error: 'Year must be descriptive (e.g., "1st Year", "Grade 11"), not just digits.',
      });
    }

    const photoPath = req.file ? `/uploads/candidates/${req.file.filename}` : null;

    const created = await Candidate.create({
      level: lvl,
      position,
      partyList,
      firstName,
      middleName: middleName || null,
      lastName,
      gender,
      year: yearStr,
      photoPath,
    });

    res.status(201).json(withPhotoUrl(req, created));
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "Failed to create candidate" });
  }
});

/* UPDATE (admin only) */
router.put("/:id", requireAdmin, runUpload, async (req, res) => {
  try {
    const row = await Candidate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });

    const { level, position, partyList, firstName, middleName, lastName, gender, year } = req.body;

    if (req.file) {
      safeUnlink(row.photoPath);
      row.photoPath = `/uploads/candidates/${req.file.filename}`;
    }

    if (level !== undefined) row.level = normLevel(level) || null;
    if (position !== undefined) row.position = position;
    if (partyList !== undefined) row.partyList = partyList;
    if (firstName !== undefined) row.firstName = firstName;
    if (middleName !== undefined) row.middleName = middleName || null;
    if (lastName !== undefined) row.lastName = lastName;
    if (gender !== undefined) row.gender = gender;
    if (year !== undefined) {
      const yearStr = toYearString(year);
      if (!yearStr) return res.status(400).json({ error: "Year cannot be empty." });
      if (/^\d+$/.test(yearStr)) {
        return res.status(400).json({
          error: 'Year must be descriptive (e.g., "1st Year", "Grade 11"), not just digits.',
        });
      }
      row.year = yearStr;
    }

    await row.save();
    res.json(withPhotoUrl(req, row));
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "Failed to update candidate" });
  }
});

/* DELETE (admin only) */
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const row = await Candidate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });

    safeUnlink(row.photoPath);
    await row.destroy();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete candidate" });
  }
});

module.exports = router;
