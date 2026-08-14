// src/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt"); // or: const bcrypt = require("bcryptjs");
const { fn, col, where } = require("sequelize"); // ← removed Op
const path = require("path");

const router = express.Router();

/* ---------- Load models from project root ---------- */
const db = require(path.join(process.cwd(), "models")); // ./models/index.js
const { Admin, Voter } = db; // make sure Voter exists

/* ---------- Helpers ---------- */
function cleanStr(v) {
  return typeof v === "string" ? v.trim() : "";
}
function isBcryptHash(s) {
  return typeof s === "string" && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(s);
}
function issueToken(res, payload) {
  if (!process.env.JWT_SECRET) throw new Error("JWT secret not configured");
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
  const isProd = process.env.NODE_ENV === "production";
 res.cookie("token", token, {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? "none" : "lax",
  path: "/",
});
  return token;
}

function readTokenFromReq(req) {
  const cookieToken = req.cookies?.token;
  if (cookieToken) return cookieToken;
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  return null;
}
function requireAuth(req, res, next) {
  try {
    const token = readTokenFromReq(req);
    if (!token) return res.status(401).json({ error: "Missing token" });
    if (!process.env.JWT_SECRET) throw new Error("JWT secret not configured");
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ---------- REGISTER (Admin) ----------
Body: { "admin_username":"admin", "admin_password":"pass" }
*/
router.post("/register", async (req, res) => {
  try {
    const admin_username = cleanStr(req.body?.admin_username);
    const admin_password_raw = cleanStr(req.body?.admin_password);
    if (!admin_username || !admin_password_raw) {
      return res.status(400).json({ error: "admin_username and admin_password are required" });
    }
    if (admin_password_raw.length < 4) {
      return res.status(400).json({ error: "Password too short" });
    }

    // case-insensitive uniqueness
    const exists = await Admin.findOne({
      where: where(fn("LOWER", col("admin_username")), admin_username.toLowerCase()),
    });
    if (exists) return res.status(409).json({ error: "Username already exists" });

    // respect model hooks if any
    const hasBeforeCreateHook =
      Admin?.options?.hooks?.beforeCreate && Admin.options.hooks.beforeCreate.length > 0;

    const admin = await Admin.create({
      admin_username,
      admin_password: hasBeforeCreateHook
        ? admin_password_raw
        : await bcrypt.hash(admin_password_raw, 10),
    });

    return res.status(201).json({ id: admin.id, admin_username: admin.admin_username });
  } catch (e) {
    if (e?.name === "SequelizeUniqueConstraintError") {
      return res.status(409).json({ error: "Username already exists" });
    }
    console.error("[AUTH /register]", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------- LOGIN (Admin or Student) ----------
Accepts:
- New: { "username":"...", "password":"..." }
- Also accepts { "schoolId":"..." } or legacy { "admin_username":"...", "admin_password":"..." }
*/
router.post("/login", async (req, res) => {
  try {
    const usernameInput =
      cleanStr(req.body?.username) ||
      cleanStr(req.body?.schoolId) ||
      cleanStr(req.body?.admin_username);

    const passwordInput =
      cleanStr(req.body?.password) ||
      cleanStr(req.body?.admin_password);

    if (!usernameInput || !passwordInput) {
      return res.status(400).json({ error: "username/schoolId and password are required" });
    }

    /* --- 1) Try ADMIN by admin_username (case-insensitive) --- */
    const admin = await Admin.findOne({
      where: where(fn("LOWER", col("admin_username")), usernameInput.toLowerCase()),
    });

    if (admin) {
      const stored = admin.admin_password || admin.passwordHash || "";
      let ok = false;

      if (typeof admin.checkPassword === "function") {
        ok = await admin.checkPassword(passwordInput);
      } else if (isBcryptHash(stored)) {
        ok = await bcrypt.compare(passwordInput, stored);
      } else {
        ok = passwordInput === stored; // legacy plaintext
        if (ok) {
          try {
            admin.admin_password = await bcrypt.hash(passwordInput, 10);
            await admin.save();
            console.log("[AUTH] Upgraded admin password to bcrypt.");
          } catch (err) {
            console.warn("[AUTH] Admin password upgrade failed:", err?.message);
          }
        }
      }

      if (!ok) return res.status(401).json({ error: "Invalid credentials" });

      issueToken(res, { sub: String(admin.id), role: "admin", username: admin.admin_username });
      return res.json({
        role: "admin",
        user: { id: admin.id, username: admin.admin_username },
      });
    }

    /* --- 2) Try STUDENT via Voter by schoolId ONLY (case-insensitive) --- */
    if (!Voter) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Use LOWER(school_id) = lower(input) to be case-insensitive
    const voter = await Voter.findOne({
      where: where(fn("LOWER", col("school_id")), usernameInput.toLowerCase()),
    });

    if (!voter) return res.status(401).json({ error: "Invalid credentials" });

    // Common password fields: password_hash -> passwordHash in model
    const vStored =
      voter.passwordHash ||
      voter.password ||
      voter.voter_password ||
      "";

    let vOk = false;
    if (isBcryptHash(vStored)) {
      vOk = await bcrypt.compare(passwordInput, vStored);
    } else {
      vOk = passwordInput === vStored; // legacy plaintext
      if (vOk) {
        try {
          if ("passwordHash" in voter) {
            voter.passwordHash = await bcrypt.hash(passwordInput, 10);
          } else if ("password" in voter) {
            voter.password = await bcrypt.hash(passwordInput, 10);
          } else if ("voter_password" in voter) {
            voter.voter_password = await bcrypt.hash(passwordInput, 10);
          }
          await voter.save();
          console.log("[AUTH] Upgraded voter password to bcrypt.");
        } catch (err) {
          console.warn("[AUTH] Voter password upgrade failed:", err?.message);
        }
      }
    }

    if (!vOk) return res.status(401).json({ error: "Invalid credentials" });

    issueToken(res, {
      sub: String(voter.id),
      role: "student",
      schoolId: voter.schoolId,
      fullName: voter.fullName,
      department: voter.department,
    });

    return res.json({
      role: "student",
      user: {
        id: voter.id,
        schoolId: voter.schoolId,
        fullName: voter.fullName,
        department: voter.department,
      },
    });
  } catch (e) {
    console.error("[AUTH /login]", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------- /me (who am I?) ---------- */
router.get("/me", requireAuth, (req, res) => {
  const { sub, role, username, schoolId, fullName, department } = req.user || {};
  res.json({ user: { id: sub, role, username, schoolId, fullName, department } });
});

/* ---------- /logout ---------- */
router.post("/logout", (_req, res) => {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("token", "", {
    httpOnly: true,
    secure: isProd, // true in Render
    sameSite: isProd ? "none" : "lax",  // 👈 must match login cookie
    maxAge: 0,
    path: "/",
  });
  res.json({ ok: true });
});
/* ---------- CHANGE PASSWORD (student or admin) ---------- 
Body: { currentPassword: string, newPassword: string }
Auth: required (uses cookie/Bearer)
*/
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const currentPassword = cleanStr(req.body?.currentPassword);
    const newPassword = cleanStr(req.body?.newPassword);

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ error: "New password must be at least 4 characters" });
    }

    const { role, sub } = req.user || {};
    if (role === "student") {
      if (!Voter) return res.status(500).json({ error: "Voter model missing" });
      const voter = await Voter.findByPk(sub);
      if (!voter) return res.status(404).json({ error: "Account not found" });

      const stored = voter.passwordHash || voter.password || voter.voter_password || "";
      let ok = false;
      if (isBcryptHash(stored)) ok = await bcrypt.compare(currentPassword, stored);
      else ok = currentPassword === stored;
      if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

      const hash = await bcrypt.hash(newPassword, 10);
      if ("passwordHash" in voter) voter.passwordHash = hash;
      else if ("password" in voter) voter.password = hash;
      else if ("voter_password" in voter) voter.voter_password = hash;
      else return res.status(500).json({ error: "No password field in Voter schema" });

      await voter.save();

      // Re-issue token (same payload) para fresh cookie
      issueToken(res, {
        sub: String(voter.id),
        role: "student",
        schoolId: voter.schoolId,
        fullName: voter.fullName,
        department: voter.department,
      });

      return res.json({ ok: true, message: "Password updated" });
    }

    if (role === "admin") {
      const admin = await Admin.findByPk(sub);
      if (!admin) return res.status(404).json({ error: "Account not found" });

      const stored = admin.admin_password || admin.passwordHash || "";
      let ok = false;
      if (typeof admin.checkPassword === "function") {
        ok = await admin.checkPassword(currentPassword);
      } else if (isBcryptHash(stored)) {
        ok = await bcrypt.compare(currentPassword, stored);
      } else {
        ok = currentPassword === stored;
      }
      if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

      const hash = await bcrypt.hash(newPassword, 10);
      if ("admin_password" in admin) admin.admin_password = hash;
      else if ("passwordHash" in admin) admin.passwordHash = hash;
      else admin.admin_password = hash;

      await admin.save();

      issueToken(res, { sub: String(admin.id), role: "admin", username: admin.admin_username });

      return res.json({ ok: true, message: "Password updated" });
    }

    return res.status(403).json({ error: "Unsupported role" });
  } catch (e) {
    console.error("[AUTH /change-password]", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------- Ping (quick health) ---------- */
router.get("/ping", (_req, res) => res.json({ ok: true, scope: "auth" }));

module.exports = router;
