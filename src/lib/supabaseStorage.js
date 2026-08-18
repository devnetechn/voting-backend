// src/lib/supabaseStorage.js
// Candidate photo storage backed by Supabase Storage.
//
// Render's disk is ephemeral: every redeploy/restart wipes files written to
// the local filesystem, but the `candidates.photo_path` DB rows keep pointing
// at the old (now-missing) files, which is why photos were "disappearing".
// Storing photos in Supabase Storage instead keeps them across restarts.
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || "candidate-photos";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

if (!supabase) {
  console.warn(
    "[supabaseStorage] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — candidate photo uploads will fail until configured."
  );
}

/** Uploads a multer memory-storage file to Supabase Storage. Returns the storage key (stored as candidates.photo_path). */
async function uploadCandidatePhoto(file) {
  if (!supabase) throw new Error("Supabase storage is not configured (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  const safe = String(file.originalname || "photo").replace(/[^\w.-]/g, "_").slice(-100);
  const key = `${Date.now()}-${safe}`;

  const { error } = await supabase.storage.from(BUCKET).upload(key, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });
  if (error) throw error;

  return key;
}

/** Best-effort delete; safe to call on legacy/foreign photoPath values. */
async function deleteCandidatePhoto(photoPath) {
  if (!photoPath || !supabase) return;
  if (/^https?:\/\//i.test(photoPath) || photoPath.startsWith("/")) return; // not a Supabase key
  try {
    await supabase.storage.from(BUCKET).remove([photoPath]);
  } catch {
    /* ignore — never block the request on cleanup */
  }
}

/** Resolves a stored photoPath (Supabase key, legacy "/uploads/..." path, or already-absolute URL) to a browser-usable URL. */
function resolvePhotoUrl(photoPath, req) {
  if (!photoPath) return null;
  if (/^https?:\/\//i.test(photoPath)) return photoPath;
  if (photoPath.startsWith("/uploads")) {
    // Legacy local-disk path from before the Supabase migration — kept so
    // local dev (no Supabase config) still works via express.static.
    return `${req.protocol}://${req.get("host")}${photoPath}`;
  }
  if (!supabase) return null;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(photoPath);
  return data?.publicUrl || null;
}

module.exports = { uploadCandidatePhoto, deleteCandidatePhoto, resolvePhotoUrl, BUCKET };
