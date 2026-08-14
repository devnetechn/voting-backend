"use strict";
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, DataTypes) {
    await queryInterface.createTable("settings", {
      key: { type: DataTypes.STRING(100), primaryKey: true, allowNull: false },
      value: { type: DataTypes.TEXT, allowNull: false, defaultValue: "false" },
      created_at: { allowNull: false, type: DataTypes.DATE, defaultValue: DataTypes.NOW },
      updated_at: { allowNull: false, type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    });

    // default: voting closed
    await queryInterface.sequelize.query(`
      INSERT INTO "settings" ("key","value","created_at","updated_at")
      VALUES ('voting_open','false',NOW(),NOW())
      ON CONFLICT ("key") DO NOTHING;
    `);
  },
  async down(queryInterface) {
    await queryInterface.dropTable("settings");
  },
};
