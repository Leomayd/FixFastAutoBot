import express from "express";
import { Telegraf } from "telegraf";

console.log("SERVER VERSION: 2026-02-11_fixfast_webapp_only");

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
const MANAGER_CHAT_ID = (process.env.MANAGER_CHAT_ID || "").trim();

const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const WELCOME_IMAGE_URL = (process.env.WELCOME_IMAGE_URL || "").trim();

const TOPIC_ID_WASH = (process.env.TOPIC_ID_WASH || "").trim();
const TOPIC_ID_SERVICE = (process.env.TOPIC_ID_SERVICE || "").trim();
const TOPIC_ID_DETAILING = (process.env.TOPIC_ID_DETAILING || "").trim();
const TOPIC_ID_BODY = (process.env.TOPIC_ID_BODY || "").trim();
const TOPIC_ID_TUNING = (process.env.TOPIC_ID_TUNING || "").trim();

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env is required");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL env is required");
if (!MANAGER_CHAT_ID) throw new Error("MANAGER_CHAT_ID env is required");
if (!WEBAPP_URL) throw new Error("WEBAPP_URL env is required");

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- logs
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

// ---- CORS (для Vercel мини-аппа)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// topic ids (если env пустой — дефолты из твоих сообщений)
const TOPICS = {
  wash_tires: TOPIC_ID_WASH ? Number(TOPIC_ID_WASH) : 2,
  service: TOPIC_ID_SERVICE ? Number(TOPIC_ID_SERVICE) : 4,
  detailing: TOPIC_ID_DETAILING ? Number(TOPIC_ID_DETAILING) : 6,
  bodywork: TOPIC_ID_BODY ? Number(TOPIC_ID_BODY) : 8,
  tuning: TOPIC_ID_TUNING ? Number(TOPIC_ID_TUNING) : 10,
};

const LABELS = {
  wash_tires: "Мойка/шиномонтаж",
  service: "ТО/Ремонт",
  detailing: "Детейлинг",
  bodywork: "Кузовной ремонт",
  tuning: "Тюнинг",
};

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// твой miniapp отправляет category строкой на русском.
// маппим в наши ключи топиков:
function mapCategoryToTopicKey(category) {
  const c = String(category || "").toLowerCase().trim();
  if (!c) return "";

  if (c.includes("мойка") || c.includes("шином")) return "wash_tires";
  if (c.includes("то") || c.includes("ремонт")) return "service";
  if (c.includes("детейл")) return "detailing";
  if (c.includes("кузов")) return "bodywork";
  if (c.includes("тюнинг")) return "tuning";

  return "";
}

async function sendToForumTopic(topicKey, htmlText) {
  const threadId = TOPICS[topicKey];
  if (!threadId) throw new Error(`Unknown topicKey: ${topicKey}`);

  return bot.telegram.sendMessage(MANAGER_CHAT_ID, htmlText, {
    parse_mode: "HTML",
    message_thread_id: threadId,
    disable_web_page_preview: true,
  });
}

// ---------------- BOT: только welcome + кнопка открыть миниапп ----------------
bot.start(async (ctx) => {
  const caption =
    `🚗 <b>FixFast</b>\n` +
    `Авто-консьерж сервис\n\n` +
    `Оформляйте заявку в мини-приложении 👇`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "🚀 Открыть приложение", web_app: { url: WEBAPP_URL } }]],
    },
  };

  try {
    if (WELCOME_IMAGE_URL) {
      await ctx.replyWithPhoto(
        { url: WELCOME_IMAGE_URL },
        { caption, parse_mode: "HTML", ...keyboard }
      );
    } else {
      await ctx.reply(caption, { parse_mode: "HTML", ...keyboard });
    }
  } catch (e) {
    console.error("WELCOME SEND ERROR:", e);
    // запасной вариант, если фото по URL не отдается
    await ctx.reply(caption, { parse_mode: "HTML", ...keyboard });
  }
});

// никаких диалогов в боте
bot.on("message", async () => {});

// ---------------- API: то, что дергает miniapp ----------------

// health + версия
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/api/ping", (_req, res) =>
  res.json({ ok: true, version: "2026-02-11_fixfast_webapp_only" })
);

// ТВОЙ ENDPOINT ИЗ МИНИАППА:
app.post("/api/request", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("[API] /api/request body:", JSON.stringify(body));

    const topicKey = mapCategoryToTopicKey(body.category);
    if (!topicKey) {
      return res.status(400).json({ ok: false, error: "Unknown category" });
    }

    const categoryLabel = escapeHtml(body.category || LABELS[topicKey] || topicKey);
    const carClass = escapeHtml(body.carClass || "");
    const carModel = escapeHtml(body.carModel || "");
    const description = escapeHtml(body.description || "");

    const tgUser = body.tgUser || null;
    const who = tgUser?.username
      ? `@${escapeHtml(tgUser.username)} (${escapeHtml(tgUser.id)})`
      : tgUser?.id
      ? `${escapeHtml(tgUser.id)}`
      : "WebApp";

    const html =
      `🆕 <b>Новая заявка</b>\n` +
      `Категория: <b>${categoryLabel}</b>\n` +
      (carClass ? `Класс: <b>${carClass}</b>\n` : "") +
      (carModel ? `Модель: <b>${carModel}</b>\n` : "") +
      (description ? `Описание: ${description}\n` : "") +
      `\nКлиент: ${who}\n` +
      `🕒 ${escapeHtml(new Date().toLocaleString("ru-RU"))}`;

    await sendToForumTopic(topicKey, html);

    return res.json({ ok: true });
  } catch (e) {
    console.error("API ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------- WEBHOOK ----------------
app.use(bot.webhookCallback(WEBHOOK_PATH));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("Server listening:", PORT);
    console.log("Webhook set:", WEBHOOK_URL);
    console.log("WEBAPP_URL:", WEBAPP_URL);
    console.log("WELCOME_IMAGE_URL:", WELCOME_IMAGE_URL ? "set" : "not set");
  } catch (e) {
    console.error("Failed to set webhook:", e);
  }
});
