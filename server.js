import express from "express";
import { Telegraf } from "telegraf";

// ===== ENV (trim!) =====
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();
const MANAGER_CHAT_ID = (process.env.MANAGER_CHAT_ID || "").trim();

const TOPIC_ID_WASH = (process.env.TOPIC_ID_WASH || "").trim();
const TOPIC_ID_SERVICE = (process.env.TOPIC_ID_SERVICE || "").trim();
const TOPIC_ID_DETAILING = (process.env.TOPIC_ID_DETAILING || "").trim();
const TOPIC_ID_BODY = (process.env.TOPIC_ID_BODY || "").trim();
const TOPIC_ID_TUNING = (process.env.TOPIC_ID_TUNING || "").trim();

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env is required");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL env is required");
if (!MANAGER_CHAT_ID) throw new Error("MANAGER_CHAT_ID env is required");

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CORS for WebApp =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // потом можно ограничить доменом
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${W
