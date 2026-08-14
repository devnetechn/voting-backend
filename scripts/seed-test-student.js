// One-off dev script: seeds a test student (Voter) account + sample candidates
// so the student-dashboard voting flow can be tested end-to-end locally.
// Usage: node scripts/seed-test-student.js
"use strict";

require("dotenv").config();
const path = require("path");
const bcrypt = require("bcrypt");
const { DataTypes } = require("sequelize");

const db = require(path.join(process.cwd(), "models"));
const { sequelize, Voter, Candidate } = db;

const TEST_SCHOOL_ID = "TEST-0001";
const TEST_PASSWORD = "test1234";
const TEST_DEPARTMENT = "College";

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

const CANDIDATES = [
  { position: "President", firstName: "Andrea", lastName: "Santos", gender: "Female", partyList: "Unity Party" },
  { position: "President", firstName: "Miguel", lastName: "Reyes", gender: "Male", partyList: "Progress Coalition" },
  { position: "Vice President", firstName: "Kyla", lastName: "Torres", gender: "Female", partyList: "Unity Party" },
  { position: "Vice President", firstName: "Josh", lastName: "Ramos", gender: "Male", partyList: "Progress Coalition" },
  { position: "Secretary", firstName: "Bea", lastName: "Cruz", gender: "Female", partyList: "Unity Party" },
  { position: "Secretary", firstName: "Ivan", lastName: "Mercado", gender: "Male", partyList: "Progress Coalition" },
  { position: "Treasurer", firstName: "Nadine", lastName: "Aquino", gender: "Female", partyList: "Unity Party" },
  { position: "Treasurer", firstName: "Carlo", lastName: "Villanueva", gender: "Male", partyList: "Progress Coalition" },
  { position: "Auditor", firstName: "Trisha", lastName: "Gonzales", gender: "Female", partyList: "Unity Party" },
  { position: "Auditor", firstName: "Paolo", lastName: "Bautista", gender: "Male", partyList: "Progress Coalition" },
  { position: "Representative", firstName: "Sam", lastName: "Del Rosario", gender: "Male", partyList: "Independent" },
  { position: "Representative", firstName: "Ella", lastName: "Navarro", gender: "Female", partyList: "Independent" },
];

async function main() {
  await sequelize.authenticate();

  // 1) Test student (Voter)
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const [voter, created] = await Voter.findOrCreate({
    where: { schoolId: TEST_SCHOOL_ID, department: TEST_DEPARTMENT },
    defaults: {
      fullName: "Juan Dela Cruz",
      course: "BSIT",
      year: "1st Year",
      status: 0,
      department: TEST_DEPARTMENT,
      passwordHash,
    },
  });
  if (!created) {
    voter.passwordHash = passwordHash;
    voter.fullName = voter.fullName || "Juan Dela Cruz";
    await voter.save();
  }
  console.log(
    created
      ? `Created test student: ${TEST_SCHOOL_ID}`
      : `Test student already existed: ${TEST_SCHOOL_ID} (password reset to default)`
  );

  // 2) Sample candidates for that department (only if none exist yet)
  const existingCount = await Candidate.count({ where: { level: TEST_DEPARTMENT } });
  if (existingCount === 0) {
    for (const c of CANDIDATES) {
      await Candidate.create({
        level: TEST_DEPARTMENT,
        firstName: c.firstName,
        middleName: null,
        lastName: c.lastName,
        position: c.position,
        partyList: c.partyList,
        gender: c.gender,
        year: TEST_DEPARTMENT === "College" ? "1st Year" : "",
      });
    }
    console.log(`Created ${CANDIDATES.length} sample candidates for ${TEST_DEPARTMENT}.`);
  } else {
    console.log(`Skipped candidate seed — ${existingCount} candidate(s) already exist for ${TEST_DEPARTMENT}.`);
  }

  // 3) Make sure voting is open so the test account can actually vote
  await Setting.upsert({ key: "voting_open", value: "true" });
  console.log("Voting status set to OPEN.");

  console.log("\nDone. Test login:");
  console.log(`  School ID: ${TEST_SCHOOL_ID}`);
  console.log(`  Password:  ${TEST_PASSWORD}`);

  await sequelize.close();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
