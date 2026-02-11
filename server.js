import express from "express";
import { Telegraf } from "telegraf";

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

// ===== request logging (чтобы поймать мини-апп) =====
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

// ===== CORS for WebApp =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

const TOPICS = {
  wash_tires: TOPIC_ID_WASH ? Number(TOPIC_ID_WASH) : 2,
  service: TOPIC_ID_SERVICE ? Number(TOPIC_ID_SERVICE) : 4,
  detailing: TOPIC_ID_DETAILING ? Number(TOPIC_ID_DETAILING) : 6,
  bodywork: TOPIC_ID_BODY ? Number(TOPIC_ID_BODY) : 8,
  tuning: TOPIC_ID_TUNING ? Number(TOPIC_ID_TUNING) : 10
};

const LABELS = {
  wash_tires: "Мойка / Шиномонтаж",
  service: "ТО / Ремонт",
  detailing: "Детейлинг",
  bodywork: "Кузовной ремонт",
  tuning: "Тюнинг"
};

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeServiceKey(s) {
  const v = String(s || "").toLowerCase().trim();
  if (!v) return "";
  if (TOPICS[v]) return v;

  if (["wash", "мойка", "шин", "tire"].some(x => v.includes(x))) return "wash_tires";
  if (["service", "repair", "то", "ремонт"].some(x => v.includes(x))) return "service";
  if (["detailing", "detail", "детейл"].some(x => v.includes(x))) return "detailing";
  if (["body", "bodywork", "кузов"].some(x => v.includes(x))) return "bodywork";
  if (["tuning", "тюнинг"].some(x => v.includes(x))) return "tuning";

  return v;
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

// ===== BOT: только welcome + кнопка =====
bot.start(async (ctx) => {
  const caption =
    `🚗 <b>FixFast</b>\n` +
    `Здравствуйте, на связи команда Fix Fast. Мы предоставляем услуги автомобильного консьерж-сервиса и с радостью решим любой вопрос по обслужеванию вашего автомобиля.\n\n` +
    `Оформляйте заявку в мини-приложении.\n` +
    `Нажмите кнопку ниже 👇`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "🚀 Открыть приложение", web_app: { url: WEBAPP_URL } }]]
    }
  };

  console.log("[BOT] /start from", ctx.from?.id);

  if (WELCOME_IMAGE_URL) {
    await ctx.replyWithPhoto(
      { url: WELCOME_IMAGE_URL },
      { caption, parse_mode: "HTML", ...keyboard }
    );
  } else {
    await ctx.reply(caption, { parse_mode: "HTML", ...keyboard });
  }
});

// чтобы не было “выбери услугу”
bot.on("message", async (ctx) => {
  // молчим
});

// ===== MINI-APP API =====
app.get("/lead", (_req, res) => {
  res.status(200).send("OK. Use POST /lead");
});

app.post("/lead", async (req, res) => {
  try {
    console.log("[LEAD] body:", JSON.stringify(req.body || {}));

    const body = req.body || {};
    const serviceKey = normalizeServiceKey(body.service || body.category || body.topic);
    if (!serviceKey || !TOPICS[serviceKey]) {
      return res.status(400).json({ ok: false, error: "Invalid service/topic" });
    }

    const carClass = body.carClass || body.class || "";
    const brandModel = body.brandModel || body.model || body.car || "";
    const comment = body.comment || body.description || "";
    const name = body.name || body.clientName || "";
    const phone = body.phone || body.clientPhone || "";

    const tgUser = body.tgUser || body.user || null;
    const who = tgUser?.username
      ? `@${escapeHtml(tgUser.username)} (${escapeHtml(tgUser.id)})`
      : tgUser?.id
      ? `id:${escapeHtml(tgUser.id)}`
      : "WebApp";

    const html =
      `🆕 <b>Новая заявка</b>\n` +
      `Категория: <b>${escapeHtml(LABELS[serviceKey] || serviceKey)}</b>\n` +
      (carClass ? `Класс: <b>${escapeHtml(carClass)}</b>\n` : "") +
      (brandModel ? `Модель: <b>${escapeHtml(brandModel)}</b>\n` : "") +
      (comment ? `Описание: ${escapeHtml(comment)}\n` : "") +
      (name ? `\nИмя: <b>${escapeHtml(name)}</b>` : "") +
      (phone ? `\nТелефон: <b>${escapeHtml(phone)}</b>` : "") +
      `\n\nКлиент: ${who}\n` +
      `Время: ${escapeHtml(new Date().toISOString())}`;

    await sendToForumTopic(serviceKey, html);

    res.json({ ok: true });
  } catch (e) {
    console.error("LEAD ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// алиасы
app.post("/submit", (req, res) => {
  req.url = "/lead";
  app._router.handle(req, res);
});
app.post("/api/lead", (req, res) => {
  req.url = "/lead";
  app._router.handle(req, res);
});
app.post("/api/submit", (req, res) => {
  req.url = "/lead";
  app._router.handle(req, res);
});

// webhook callback
app.use(bot.webhookCallback(WEBHOOK_PATH));

// healthcheck
app.get("/", (_req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("Server listening on port:", PORT);
    console.log("PUBLIC_URL:", PUBLIC_URL);
    console.log("WEBAPP_URL:", WEBAPP_URL);
    console.log("WELCOME_IMAGE_URL:", WELCOME_IMAGE_URL ? "set" : "not set");
    console.log("Webhook set to:", WEBHOOK_URL);
  } catch (e) {
    console.error("Failed to set webhook:", e);
  }
});
