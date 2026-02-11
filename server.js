import express from "express";
import crypto from "crypto";
import { Telegraf, Markup } from "telegraf";

console.log("SERVER VERSION: 2026-02-12_fixfast_statuses_v1");

// =============== ENV ===============
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

const app = express();
app.use(express.json({ limit: "1mb" }));

// logs
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

// CORS for Vercel miniapp
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const bot = new Telegraf(BOT_TOKEN);

const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// forum topics
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

// =============== Memory store (MVP) ===============
/**
 * request = {
 *  id, userId, categoryKey, categoryLabel,
 *  carClass, carModel, description,
 *  car: { id,title,plate,carClass } | null,
 *  status: "new"|"inwork"|"done"|"canceled",
 *  createdAt, updatedAt
 * }
 */
const requests = new Map(); // id -> request
const userIndex = new Map(); // userId -> [requestId]

// =============== Utils ===============
function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

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

function statusLabel(st) {
  if (st === "new") return "🆕 Новая";
  if (st === "inwork") return "🛠️ В работе";
  if (st === "done") return "✅ Готово";
  if (st === "canceled") return "❌ Отменено";
  return st;
}

function nowRu() {
  return new Date().toLocaleString("ru-RU");
}

function mkId() {
  return crypto.randomUUID();
}

function managerKeyboard(reqId, status) {
  const row1 = [
    Markup.button.callback("✅ В работу", `req:${reqId}:inwork`),
    Markup.button.callback("✅ Готово", `req:${reqId}:done`),
  ];
  const row2 = [Markup.button.callback("❌ Отменить", `req:${reqId}:canceled`)];
  const row3 = [Markup.button.callback(`Статус: ${statusLabel(status)}`, `noop:${reqId}`)];
  return Markup.inlineKeyboard([row1, row2, row3]);
}

async function sendToForumTopic(topicKey, htmlText, extraMarkup) {
  const threadId = TOPICS[topicKey];
  if (!threadId) throw new Error(`Unknown topicKey: ${topicKey}`);

  return bot.telegram.sendMessage(MANAGER_CHAT_ID, htmlText, {
    parse_mode: "HTML",
    message_thread_id: threadId,
    disable_web_page_preview: true,
    ...(extraMarkup || {}),
  });
}

function upsertUserIndex(userId, requestId) {
  const key = String(userId);
  const arr = userIndex.get(key) || [];
  arr.unshift(requestId);
  userIndex.set(key, arr);
}

function safeUserLine(tgUser) {
  if (!tgUser) return "WebApp";
  const username = tgUser.username ? `@${escapeHtml(tgUser.username)}` : "";
  const id = tgUser.id ? `${escapeHtml(tgUser.id)}` : "";
  if (username && id) return `${username} (${id})`;
  if (username) return username;
  if (id) return id;
  return "WebApp";
}

// =============== BOT: /start only (and still respond to /start even if other messages) ===============
async function sendWelcome(ctx) {
  const caption =
    `🚗 <b>Добрый день, на связи команда Fix Fast.</b>\n` +
    `Мы предоставляем услуги авто-консьерж-сервиса и решим любой вопрос по вашему авто.\n\n` +
    `Оформите заявку в мини-приложении — менеджер возьмёт её в работу 👇`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.webApp("🚀 Открыть приложение", WEBAPP_URL)],
  ]);

  try {
    if (WELCOME_IMAGE_URL) {
      await ctx.replyWithPhoto({ url: WELCOME_IMAGE_URL }, { caption, parse_mode: "HTML", ...kb });
    } else {
      await ctx.reply(caption, { parse_mode: "HTML", ...kb });
    }
  } catch (e) {
    console.error("WELCOME SEND ERROR:", e);
    await ctx.reply(caption, { parse_mode: "HTML", ...kb });
  }
}

bot.start(sendWelcome);

// на всякий случай: если Telegram пришлет как обычный текст "/start"
bot.hears(/^\/start$/i, sendWelcome);

// не ломаем остальной чат
bot.on("message", async () => {});

// manager кнопки статуса
bot.action(/^req:([a-f0-9-]+):(new|inwork|done|canceled)$/i, async (ctx) => {
  const reqId = ctx.match[1];
  const newStatus = ctx.match[2];

  const r = requests.get(reqId);
  if (!r) {
    await ctx.answerCbQuery("Заявка не найдена");
    return;
  }

  r.status = newStatus;
  r.updatedAt = Date.now();
  requests.set(reqId, r);

  // обновим сообщение менеджерам (попробуем edit)
  const html =
    `🧾 <b>Заявка</b> — <b>${escapeHtml(r.categoryLabel)}</b>\n` +
    `Статус: <b>${escapeHtml(statusLabel(r.status))}</b>\n\n` +
    (r.car?.title ? `🚗 <b>Авто:</b> ${escapeHtml(r.car.title)}\n` : "") +
    (r.car?.plate ? `🔢 <b>Номер:</b> ${escapeHtml(r.car.plate)}\n` : "") +
    `🚘 <b>Класс:</b> ${escapeHtml(r.carClass)}\n` +
    `🚗 <b>Модель:</b> ${escapeHtml(r.carModel)}\n` +
    `📝 <b>Описание:</b> ${escapeHtml(r.description)}\n\n` +
    `👤 <b>Клиент:</b> ${escapeHtml(r.clientLine)}\n` +
    `🆔 <b>ID:</b> <code>${escapeHtml(r.id)}</code>\n` +
    `🕒 ${escapeHtml(nowRu())}`;

  try {
    await ctx.editMessageText(html, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...managerKeyboard(r.id, r.status),
    });
  } catch (e) {
    // если не получилось edit (например, старое сообщение) — ничего страшного
    console.warn("editMessageText failed:", e?.message || e);
  }

  // пинганём клиента (если чат с ботом есть)
  try {
    await bot.telegram.sendMessage(
      r.userId,
      `🔔 Статус вашей заявки обновлён: ${statusLabel(r.status)}\n${r.categoryLabel} • ${r.carModel}`,
      Markup.inlineKeyboard([[Markup.button.webApp("Открыть приложение", WEBAPP_URL)]])
    );
  } catch (e) {
    // если клиент не писал боту — Telegram не даст отправить
  }

  await ctx.answerCbQuery(`Статус: ${statusLabel(newStatus)}`);
});

bot.action(/^noop:/i, async (ctx) => {
  await ctx.answerCbQuery("Ок");
});

// =============== API ===============
// health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/api/ping", (_req, res) => res.json({ ok: true, version: "2026-02-12_fixfast_statuses_v1" }));

// create request (from miniapp)
app.post("/api/request", async (req, res) => {
  try {
    const body = req.body || {};

    const topicKey = mapCategoryToTopicKey(body.category);
    if (!topicKey) return res.status(400).json({ ok: false, error: "Unknown category" });

    const categoryLabel = body.category || LABELS[topicKey] || topicKey;

    const tgUser = body.tgUser || null;
    const userId = tgUser?.id ? String(tgUser.id) : "";
    if (!userId) return res.status(400).json({ ok: false, error: "tgUser.id is required" });

    const carClass = String(body.carClass || "").trim();
    const carModel = String(body.carModel || "").trim();
    const description = String(body.description || "").trim();
    if (!carModel || !description) return res.status(400).json({ ok: false, error: "Missing fields" });

    const car = body.car || null;

    const reqId = mkId();
    const r = {
      id: reqId,
      userId,
      categoryKey: topicKey,
      categoryLabel: String(categoryLabel),
      carClass,
      carModel,
      description,
      car,
      status: "new",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clientLine: safeUserLine(tgUser),
    };

    requests.set(reqId, r);
    upsertUserIndex(userId, reqId);

    const html =
      `🧾 <b>Заявка</b> — <b>${escapeHtml(r.categoryLabel)}</b>\n` +
      `Статус: <b>${escapeHtml(statusLabel(r.status))}</b>\n\n` +
      (car?.title ? `🚗 <b>Авто:</b> ${escapeHtml(car.title)}\n` : "") +
      (car?.plate ? `🔢 <b>Номер:</b> ${escapeHtml(car.plate)}\n` : "") +
      `🚘 <b>Класс:</b> ${escapeHtml(r.carClass)}\n` +
      `🚗 <b>Модель:</b> ${escapeHtml(r.carModel)}\n` +
      `📝 <b>Описание:</b> ${escapeHtml(r.description)}\n\n` +
      `👤 <b>Клиент:</b> ${escapeHtml(r.clientLine)}\n` +
      `🆔 <b>ID:</b> <code>${escapeHtml(r.id)}</code>\n` +
      `🕒 ${escapeHtml(nowRu())}`;

    await sendToForumTopic(topicKey, html, managerKeyboard(reqId, r.status));

    return res.json({ ok: true, id: reqId });
  } catch (e) {
    console.error("POST /api/request error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// list my requests (client side)
app.post("/api/my-requests", async (req, res) => {
  try {
    const { tgUser } = req.body || {};
    const userId = tgUser?.id ? String(tgUser.id) : "";
    if (!userId) return res.status(400).json({ ok: false, error: "tgUser.id is required" });

    const ids = userIndex.get(userId) || [];
    const items = ids
      .map((id) => requests.get(id))
      .filter(Boolean)
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        category: r.categoryLabel,
        carClass: r.carClass,
        carModel: r.carModel,
        description: r.description,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("POST /api/my-requests error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// =============== WEBHOOK ROUTE (explicit) ===============
app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("Webhook set:", WEBHOOK_URL);
  } catch (e) {
    console.error("Webhook setup failed:", e);
  }
  console.log("Listening on:", PORT);
  console.log("WEBAPP_URL:", WEBAPP_URL);
});
