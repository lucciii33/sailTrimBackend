const express = require("express");
const router = express.Router();
const { githubCallback } = require("../controllers/githubController");

router.get("/callback", githubCallback);

module.exports = router;
