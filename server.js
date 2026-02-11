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
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// ===== TOPICS map (из env, fallback на твои номера) =====
const TOPICS = {
  wash_tires: TOPIC_ID_WASH ? Number(TOPIC_ID_WASH) : 2,
  service: TOPIC_ID_SERVICE ? Number(TOPIC_ID_SERVICE) : 4,
  detailing: TOPIC_ID_DETAILING ? Number(TOPIC_ID_DETAILING) : 6,
  bodywork: TOPIC_ID_BODY ? Number(TOPIC_ID_BODY) : 8,
  tuning: TOPIC_ID_TUNING ? Number(TOPIC_ID_TUNING) : 10
};

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeServiceKey(s) {
  const v = String(s || "").toLowerCase().trim();
  if (["wash", "wash_tires", "мойка", "шин", "tire"].some(x => v.includes(x))) return "wash_tires";
  if (["service", "repair", "то", "ремонт"].some(x => v.includes(x))) return "service";
  if (["detailing", "detail", "детейл"].some(x => v.includes(x))) return "detailing";
  if (["body", "bodywork", "кузов"].some(x => v.includes(x))) return "bodywork";
  if (["tuning", "тюнинг"].some(x => v.includes(x))) return "tuning";
  return v; // если фронт пришлёт уже правильный ключ
}

async function sendToForumTopic(topicKey, htmlText) {
  const threadId = TOPICS[topicKey];
  if (!threadId) throw new Error(`Unknown topicKey: ${topicKey}`);

  return bot.telegram.sendMessage(MANAGER_CHAT_ID, htmlText, {
    parse_mode: "HTML",
    message_thread_id: threadId,
    disable_web_page_preview: true
  });
}

// ===== API for mini-app =====
// expected JSON (пример):
// {
//   "service":"bodywork",
//   "carClass":"Бизнес",
//   "brandModel":"BMW 5",
//   "comment":"тест",
//   "name":"Leo",
//   "phone":"+7...",
//   "tgUser": {"id":..., "username":"...", "first_name":"..."}
// }
app.post("/lead", async (req, res) => {
  try {
    const body = req.body || {};
    const serviceKey = normalizeServiceKey(body.service || body.category || body.topic);

    const carClass = body.carClass || "";
    const brandModel = body.brandModel || "";
    const comment = body.comment || body.description || "";
    const name = body.name || "";
    const phone = body.phone || "";

    const tgUser = body.tgUser || body.user || null;
    const who = tgUser
      ? `${escapeHtml(tgUser.first_name || "")}${tgUser.last_name ? " " + escapeHtml(tgUser.last_name) : ""}${tgUser.username ? " (@" + escapeHtml(tgUser.username) + ")" : ""} (${escapeHtml(tgUser.id)})`
      : "WebApp";

    const labels = {
      wash_tires: "Мойка / Шиномонтаж",
      service: "ТО / Ремонт",
      detailing: "Детейлинг",
      bodywork: "Кузовной ремонт",
      tuning: "Тюнинг"
    };

    const html =
      `🆕 <b>Новая заявка</b>\n` +
      `Категория: <b>${escapeHtml(labels[serviceKey] || serviceKey)}</b>\n` +
      (carClass ? `Класс: <b>${escapeHtml(carClass)}</b>\n` : "") +
      (brandModel ? `Модель: <b>${escapeHtml(brandModel)}</b>\n` : "") +
      (comment ? `Описание: ${escapeHtml(comment)}\n` : "") +
      (name ? `Имя: <b>${escapeHtml(name)}</b>\n` : "") +
      (phone ? `Телефон: <b>${escapeHtml(phone)}</b>\n` : "") +
      `\nКлиент: ${who}\n` +
      `Время: ${escapeHtml(new Date().toISOString())}`;

    await sendToForumTopic(serviceKey, html);

    res.json({ ok: true });
  } catch (e) {
    console.error("LEAD ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// webhook callback (чтобы Telegram мог стучаться)
app.use(bot.webhookCallback(WEBHOOK_PATH));

// healthcheck
app.get("/", (_, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("Webhook set to:", WEBHOOK_URL);
    console.log("Server listening on port:", PORT);
  } catch (e) {
    console.error("Failed to set webhook:", e);
  }
});
