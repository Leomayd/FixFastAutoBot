import express from "express";
import { Telegraf, Markup } from "telegraf";

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // https://fixfastautobot.onrender.com
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID; // id форум-чата (группа с топиками)

const WEBAPP_URL = process.env.WEBAPP_URL; // URL мини-аппа (Vercel), напр: https://fixfast-miniapp.vercel.app
const WELCOME_IMAGE_URL = process.env.WELCOME_IMAGE_URL; // картинка для приветствия (https://...)

const TOPIC_ID_WASH = process.env.TOPIC_ID_WASH; // 2
const TOPIC_ID_SERVICE = process.env.TOPIC_ID_SERVICE; // 4
const TOPIC_ID_DETAILING = process.env.TOPIC_ID_DETAILING; // 6
const TOPIC_ID_BODY = process.env.TOPIC_ID_BODY; // 8
const TOPIC_ID_TUNING = process.env.TOPIC_ID_TUNING; // 10

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env is required");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL env is required");
if (!MANAGER_CHAT_ID) throw new Error("MANAGER_CHAT_ID env is required");
if (!WEBAPP_URL) throw new Error("WEBAPP_URL env is required");
if (!WELCOME_IMAGE_URL) throw new Error("WELCOME_IMAGE_URL env is required");

// ================== APP / BOT ==================
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CORS (чтобы мини-апп с Vercel нормально стучался на Render) =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // можно ужесточить до своего Vercel домена
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ================== WEBHOOK ==================
const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// ================== TOPICS ==================
const TOPICS = {
  "Мойка/шиномонтаж": Number(TOPIC_ID_WASH || 0),
  "ТО/Ремонт": Number(TOPIC_ID_SERVICE || 0),
  "Детейлинг": Number(TOPIC_ID_DETAILING || 0),
  "Кузовной ремонт": Number(TOPIC_ID_BODY || 0),
  "Тюнинг": Number(TOPIC_ID_TUNING || 0),
};

// ================== UTILS ==================
function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pickTopicId(category) {
  const id = TOPICS[category];
  return id && Number.isFinite(id) ? id : null;
}

async function sendToTopic(topicId, htmlText) {
  return bot.telegram.sendMessage(MANAGER_CHAT_ID, htmlText, {
    parse_mode: "HTML",
    message_thread_id: topicId,
    disable_web_page_preview: true,
  });
}

// ================== BOT: ONLY WELCOME ==================
bot.start(async (ctx) => {
  const caption =
    `🚗 <b>Добрый день, на связи команда Fix Fast.</b>\n` +
    `Мы предоставляем услуги авто-консьерж-сервиса и с радостью решим любой вопрос по вашему авто.\n\n` +
    `Просто оформите заявку в мини-приложении — и мы свяжемся с вами. 👇`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.webApp("🚀 Открыть приложение", WEBAPP_URL)],
    // запасной вариант, если где-то webApp не открывается:
    [Markup.button.url("🌐 Открыть в браузере", WEBAPP_URL)],
  ]);

  try {
    await ctx.replyWithPhoto(WELCOME_IMAGE_URL, {
      caption,
      parse_mode: "HTML",
      ...kb,
    });
  } catch (e) {
    // если вдруг telegram не даёт отправить по URL — отправим без картинки, чтобы не “молчало”
    await ctx.reply(caption, { parse_mode: "HTML", ...kb });
  }
});

// никаких других обработчиков в боте НЕ делаем специально

// ================== API: REQUEST FROM MINIAPP ==================
app.post("/api/request", async (req, res) => {
  try {
    const body = req.body || {};

    const category = String(body.category || "").trim();
    const carClass = String(body.carClass || "").trim();
    const carModel = String(body.carModel || "").trim();
    const description = String(body.description || "").trim();

    // гараж (опционально)
    const car
