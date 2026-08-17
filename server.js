// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");

const app = express();

/* ---- Trust proxy (secure cookies in prod) ---- */
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

/* ---- CORS ---- */
const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowlist.length === 0 || allowlist.includes(origin)) return cb(null, true);
    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/* ---- Parsers ---- */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ---- Static uploads ---- */
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

/* ---- DB ---- */
const db = require(path.join(process.cwd(), "models"));
const { sequelize } = db;

/* ---- Auth middleware ---- */
const { requireAuth, requireRole } = require(path.join(process.cwd(), "src", "middleware", "auth"));

/* ---- Routers ---- */
const votesRouter = require(path.join(process.cwd(), "src", "routes", "votes"));
const candidateRouter = require(path.join(process.cwd(), "src", "routes", "candidate"));
const authRouter = require(path.join(process.cwd(), "src", "routes", "auth"));
const votersRouter = require(path.join(process.cwd(), "src", "routes", "voters"));

/* ---- Mount routes ---- */
// ✅ Auth routes (login, logout, me)
app.use("/api/auth", authRouter);

// ✅ Votes
app.use("/api/votes", votesRouter);

// ✅ Candidates (public GET, admin required for POST/PUT/DELETE)
app.use(
  "/api/candidates",
  (req, res, next) => {
    // Public, unauthenticated candidate listing for the pre-login "See Candidate Details" page
    if ((req.method === "GET" || req.method === "HEAD") && req.path === "/public") {
      return next();
    }
    requireAuth(req, res, () => {
      if (req.method === "GET" || req.method === "HEAD") return next();
      return requireRole("admin")(req, res, next);
    });
  },
  candidateRouter
);

// ✅ Voters (admin only)
app.use("/api/voters", requireAuth, requireRole("admin"), votersRouter);

/* ---- Health ---- */
app.get("/", (_req, res) => {
  res.send("🚀 Backend API is running. Use /api/... endpoints.");
});
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "dev" });
});

/* ---- Debug ---- */
app.get("/api/_debug/whoami", (req, res) => {
  res.json({
    cookieNames: Object.keys(req.cookies || {}),
    hasAuthHeader: Boolean(req.headers.authorization),
    origin: req.headers.origin || null,
  });
});
app.get("/api/_debug/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/* ---- Error handler ---- */
app.use((err, _req, res, _next) => {
  console.error(err);
  const isCORS = String(err?.message || "").startsWith("Not allowed by CORS");
  const status = isCORS ? 403 : 500;
  res.status(status).json({ error: err.message || "Server error" });
});

/* ---- Start ---- */
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || "0.0.0.0";

sequelize
  .authenticate()
  .then(() => console.log("✅ DB connected"))
  .catch((err) => console.error("❌ DB connection failed:", err.message));

app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on ${HOST}:${PORT}`);
});
