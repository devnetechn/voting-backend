// src/routes/votes.js
const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
const { DataTypes } = require("sequelize");

const router = express.Router();
const { requireAuth, requireRole } = require(path.join(process.cwd(), "src", "middleware", "auth"));
/* ---------- DB ---------- */
const db = require(path.join(process.cwd(), "models"));
const { sequelize, Candidate, Vote: VoteModel, Voter } = db; 

//set of time
const Setting =
  db.Setting ||
  sequelize.define(
    "Setting",
    {
      key: { type: DataTypes.STRING(100), primaryKey: true },
      value: { type: DataTypes.TEXT, allowNull: false, defaultValue: "false" },
    },
    { tableName: "settings", timestamps: true, createdAt: "created_at", updatedAt: "updated_at" }
  );

if (typeof Setting.sync === "function") {
  // safe in dev; in prod rely on migration
  Setting.sync().catch(() => {});
}

async function getVotingOpen() {
  const row = await Setting.findByPk("voting_open");
  return row ? String(row.value) === "true" : false;
}
async function setVotingOpen(open) {
  await Setting.upsert({ key: "voting_open", value: open ? "true" : "false" });
}

// simple admin guard for this file
function requireAdmin(req, res, next) {
  try {
    const tok = readTokenFromReq(req);
    if (!tok || !process.env.JWT_SECRET) return res.status(401).json({ error: "Unauthorized" });
    const u = jwt.verify(tok, process.env.JWT_SECRET);
    if ((u.role || "").toLowerCase() !== "admin") return res.status(403).json({ error: "Forbidden" });
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/* ---------- Vote model (aligned to snake_case table) ---------- */
const Vote =
  VoteModel ||
  sequelize.define(
    "Vote",
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

      // 👇 map camelCase fields to snake_case columns
      voterId:    { type: DataTypes.UUID,  allowNull: false, field: "voter_id" },
      candidateId:{ type: DataTypes.UUID,  allowNull: false, field: "candidate_id" },

      // if your migration used ENUMs, keep them here; if you switched to STRING in DB, change these to STRING
      position: {
        type: DataTypes.ENUM(
          "President",
          "Vice President",
          "Secretary",
          "Treasurer",
          "Auditor",
          "Representative"
        ),
        allowNull: false,
      },
      level: {
        type: DataTypes.ENUM("Elementary", "JHS", "SHS", "College"),
        allowNull: false,
      },

      createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
      updatedAt: { type: DataTypes.DATE, allowNull: false, field: "updated_at" },
    },
    {
      tableName: "votes",
      underscored: true,
      timestamps: true,
      // index already created by migration; no need to re-declare here
    }
  );

// ❌ DO NOT call Vote.sync() — we rely on migrations only.

/* ---------- Helpers ---------- */
function readTokenFromReq(req) {
  const c = req.cookies?.token;
  if (c) return c;
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireStudent(req, res, next) {
  try {
    const tok = readTokenFromReq(req);
    if (!tok || !process.env.JWT_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const u = jwt.verify(tok, process.env.JWT_SECRET);
    if ((u.role || "").toLowerCase() !== "student") {
      return res.status(403).json({ error: "Forbidden: student role required" });
    }
    req.user = u; // { sub, role, department, ... }
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

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

/* ---------- Routes ---------- */

// GET /api/votes/me
router.get("/me", requireStudent, async (req, res) => {
  try {
    const voterId = String(req.user.sub || "").trim(); // UUID string
    if (!voterId) return res.status(401).json({ error: "Unauthorized" });

    const rows = await Vote.findAll({
      where: { voterId },
      order: [["position", "ASC"]],
    });
    res.json(rows.map((r) => r.toJSON()));
  } catch (e) {
    console.error("[VOTES GET /me]", e?.parent?.message || e?.message || e);
    res.status(500).json({ error: "Server error" });
  }
});
// Anyone logged in can read status (student/admin)
router.get("/status", async (req, res) => {
  try {
    const open = await getVotingOpen();
    res.json({ open });
  } catch (e) {
    console.error("[VOTES GET /status]", e?.message || e);
    res.status(500).json({ error: "Failed to get status" });
  }
});

// Admin can toggle
router.post("/status", requireAdmin, async (req, res) => {
  try {
    const open = Boolean(req.body?.open);
    await setVotingOpen(open);
    res.json({ ok: true, open });
  } catch (e) {
    console.error("[VOTES POST /status]", e?.message || e);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// POST /api/votes  { candidateId }
router.post("/", requireStudent, async (req, res) => {
  try {
    const voterId = String(req.user.sub || "").trim(); // UUID
    if (!voterId) return res.status(401).json({ error: "Unauthorized" });
 const open = await getVotingOpen();
    if (!open) return res.status(403).json({ error: "Voting is closed" });
    // ✅ NEW: guard vs stale token / missing FK
    const voterRow = await Voter.findByPk(voterId);
    if (!voterRow) {
      return res.status(401).json({ error: "Session invalid. Please log in again." });
    }

    const deptLevel = normLevel(req.user.department);
    if (!deptLevel) return res.status(400).json({ error: "Your department is not set" });

    const raw = req.body?.candidateId ?? req.body?.id ?? req.body?.candidate_id;
    const candidateId = String(raw || "").trim();
    if (!candidateId) return res.status(400).json({ error: "candidateId is required" });

    const cand = await Candidate.findByPk(candidateId);
    if (!cand) return res.status(404).json({ error: "Candidate not found" });

    const candLevel = normLevel(cand.level);
    if (!candLevel) return res.status(400).json({ error: "Candidate level is invalid" });
    if (candLevel !== deptLevel) {
      return res.status(403).json({ error: "You cannot vote for another department" });
    }

    const position = String(cand.position || "").trim();
    if (!position) return res.status(400).json({ error: "Candidate position missing" });

    const existing = await Vote.findOne({ where: { voterId, position, level: candLevel } });
    if (existing) {
      return res.status(409).json({
        error: "Already voted for this position",
        existing: existing.toJSON(),
      });
    }

    const created = await Vote.create({ voterId, candidateId, position, level: candLevel });
    res.status(201).json(created.toJSON());
  } catch (e) {
    if (e?.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ error: "Already voted for this position" });
    }
    console.error("[VOTES POST /]", e?.parent?.message || e?.message || e);
    res.status(500).json({ error: "Server error" });
  }
});
router.get("/stats", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { level, position } = req.query || {};
    const where = [];
    const params = {};

    if (level)   { where.push(`c.level = :level`);       params.level   = String(level); }
    if (position){ where.push(`c.position = :position`); params.position= String(position); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // 🔁 LEFT JOIN so candidates with 0 votes still show up
    const sql = `
      SELECT
        c.id           AS "candidateId",
        c.first_name   AS "firstName",
        c.middle_name  AS "middleName",
        c.last_name    AS "lastName",
        c.party_list   AS "partyList",
        c.position     AS "position",
        c.level        AS "level",
        c.photo_path   AS "photoPath",
        COUNT(v.id)    AS "votes"
      FROM candidates c
      LEFT JOIN votes v ON v.candidate_id = c.id
      ${whereSql}
      GROUP BY c.id, c.first_name, c.middle_name, c.last_name, c.party_list, c.position, c.level, c.photo_path
      ORDER BY c.level, c.position, "votes" DESC, c.last_name;
    `;

    const rows = await sequelize.query(sql, {
      replacements: params,
      type: sequelize.QueryTypes.SELECT,
    });

    const host = `${req.protocol}://${req.get("host")}`;
    const withPhotos = rows.map((r) => ({
      ...r,
      photoUrl: r.photoPath
        ? (String(r.photoPath).startsWith("/uploads") ? host + r.photoPath : r.photoPath)
        : null,
    }));

    res.json(withPhotos);
  } catch (e) {
    console.error("[VOTES GET /stats]", e?.parent?.message || e?.message || e);
    res.status(500).json({ error: "Failed to fetch vote stats" });
  }
});

// GET /api/votes/scores — delayed (15 min rolling) candidate scores for the
// logged-in voter's own department. Any authenticated student/admin can call.
router.get("/scores", requireAuth, async (req, res) => {
  try {
    const level =
      String((req.user?.role || "")).toLowerCase() === "student"
        ? normLevel(req.user?.department)
        : normLevel(req.query?.level);

    if (!level) return res.status(400).json({ error: "Department/level not set" });

    // Votes cast within the last 15 minutes are intentionally excluded so the
    // score always lags "now" by ~15 minutes.
    const sql = `
      SELECT
        c.id           AS "candidateId",
        c.first_name   AS "firstName",
        c.middle_name  AS "middleName",
        c.last_name    AS "lastName",
        c.party_list   AS "partyList",
        c.position     AS "position",
        c.level        AS "level",
        c.photo_path   AS "photoPath",
        COUNT(v.id)    AS "votes"
      FROM candidates c
      LEFT JOIN votes v
        ON v.candidate_id = c.id
        AND v.created_at <= NOW() - INTERVAL '15 minutes'
      WHERE c.level = :level
      GROUP BY c.id, c.first_name, c.middle_name, c.last_name, c.party_list, c.position, c.level, c.photo_path
      ORDER BY c.position, "votes" DESC, c.last_name;
    `;

    const rows = await sequelize.query(sql, {
      replacements: { level },
      type: sequelize.QueryTypes.SELECT,
    });

    const host = `${req.protocol}://${req.get("host")}`;
    const withPhotos = rows.map((r) => ({
      ...r,
      photoUrl: r.photoPath
        ? (String(r.photoPath).startsWith("/uploads") ? host + r.photoPath : r.photoPath)
        : null,
    }));

    res.json(withPhotos);
  } catch (e) {
    console.error("[VOTES GET /scores]", e?.parent?.message || e?.message || e);
    res.status(500).json({ error: "Failed to fetch candidate scores" });
  }
});

// POST /api/votes/reset  (admin only)
router.post("/reset", requireAdmin, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    // optional: close voting as part of reset (send { close: true } in body)
    const shouldClose = Boolean(req.body?.close);

    // count before truncate so we can report deleted
    const beforeCount = await Vote.count({ transaction: t });

    let deleted = 0;
    const dialect = sequelize.getDialect?.() || sequelize.options?.dialect || "";

    if (dialect === "postgres") {
      await sequelize.query(
        'TRUNCATE TABLE "votes" RESTART IDENTITY CASCADE',
        { transaction: t }
      );
      deleted = beforeCount;
    } else {
      deleted = await Vote.destroy({
        where: {},
        truncate: true,
        cascade: true,
        transaction: t,
      });
    }

    const [votersReset] = await Voter.update(
      { status: 0 },
      { where: {}, transaction: t }
    );

    if (shouldClose) {
      await setVotingOpen(false);
    }

    await t.commit();
    return res.json({
      ok: true,
      deletedVotes: deleted,
      votersReset,
      votingClosed: shouldClose || false,
    });
  } catch (e) {
    await t.rollback();
    console.error("[VOTES POST /reset]", e?.parent?.message || e?.message || e);
    return res.status(500).json({ error: "Failed to reset votes" });
  }
});



module.exports = router;
