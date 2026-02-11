import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const app = express();
app.use(express.json());

// --- helpers ---
function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const BOT_TOKEN = requiredEnv("BOT_TOKEN");
const MANAGER_CHAT_ID = requiredEnv("MANAGER_CHAT_ID"); // supergroup id (-100...)
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const TOPIC_MAP = [
  { key: "Мойка/шиномонтаж", env: "TOPIC_ID_WASH" },
  { key: "ТО/Ремонт", env: "TOPIC_ID_SERVICE" },
  { key: "Кузовной ремонт", env: "TOPIC_ID_BODY" },
  { key: "Детейлинг", env: "TOPIC_ID_DETAILING" },
  { key: "Тюнинг", env: "TOPIC_ID_TUNING" },
];

function topicIdByCategory(category) {
  const row = TOPIC_MAP.find((x) => x.key === category);
  if (!row) return null;
  const v = process.env[row.env];
  return v ? Number(v) : null;
}

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function tgSendMessage({ chat_id, text, message_thread_id }) {
  const body = { chat_id, text, parse_mode: "HTML" };
  if (message_thread_id) body.message_thread_id = message_thread_id;

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.description || "Telegram sendMessage failed");
  }
  return data.result;
}

// --- simple file "db" ---
const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "requests.json");

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]), "utf-8");
}
ensureDb();

function dbInsert(reqObj) {
  const arr = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  arr.push(reqObj);
  fs.writeFileSync(DB_FILE, JSON.stringify(arr, null, 2), "utf-8");
}

// --- routes ---
app.get("/", (req, res) => res.send("OK"));

app.post("/api/request", async (req, res) => {
  try {
    const { category, carClass, carModel, description, tgUser, initData } = req.body || {};

    if (!category || !carModel || !description) {
      return res.status(400).json({ ok: false, error: "Missing fields: category, carModel, description" });
    }

    const topicId = topicIdByCategory(category);
    if (!topicId) {
      return res.status(400).json({ ok: false, error: `Unknown category or topic not configured: ${category}` });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    const userLine = tgUser?.username
      ? `@${escapeHtml(tgUser.username)}`
      : tgUser?.first_name
        ? escapeHtml(tgUser.first_name)
        : "unknown";

    const userIdLine = tgUser?.id ? ` (${tgUser.id})` : "";

    const text =
      `🚗 <b>Новая заявка</b>\n` +
      `Категория: <b>${escapeHtml(category)}</b>\n` +
      `Класс: <b>${escapeHtml(carClass || "—")}</b>\n` +
      `Модель: <b>${escapeHtml(carModel)}</b>\n` +
      `Описание: <b>${escapeHtml(description)}</b>\n\n` +
      `Клиент: <b>${userLine}</b>${escapeHtml(userIdLine)}\n` +
      `ID заявки: <code>${id}</code>\n` +
      `Время: <code>${createdAt}</code>`;

    // 1) send to managers topic
    await tgSendMessage({
      chat_id: MANAGER_CHAT_ID,
      message_thread_id: topicId,
      text,
    });

    // 2) save to "db"
    dbInsert({
      id,
      createdAt,
      category,
      carClass: carClass || "",
      carModel,
      description,
      tgUser: tgUser || null,
      initData: initData || null,
    });

    return res.json({ ok: true, id });
  } catch (e) {
    console.error("ERR /api/request:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
