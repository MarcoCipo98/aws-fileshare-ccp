const path = require("path");
const express = require("express");
const morgan = require("morgan");
require("dotenv").config();

const app = express();

// Config (über Env steuerbar)
const PORT = process.env.PORT || 8080;
const APP_ENV = process.env.APP_ENV || "local";
const APP_VERSION = process.env.APP_VERSION || "0.0.1-local";

// Middlewares
app.use(morgan("combined"));     // Request logs (später CloudWatch-ähnlich)
app.use(express.json());        // JSON bodies

// Website aus /public (Repo-Root) ausliefern
app.use(express.static(path.join(__dirname, "..", "public")));

// Healthcheck (später für ALB/ASG)
app.get("/health", (req, res) => res.status(200).send("OK"));

// Version (Beweis welche Version läuft)
app.get("/version", (req, res) => res.json({ version: APP_VERSION }));

// Env (Beweis DEV/PROD)
app.get("/env", (req, res) => res.json({ env: APP_ENV }));

// 404 fallback
app.use((req, res) => res.status(404).json({ error: "Not Found" }));

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`APP_ENV=${APP_ENV} APP_VERSION=${APP_VERSION}`);
});
