import express from "express";
import crypto from "crypto";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // https://fixfastautobot.onrender.com
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID; // id форум-чата
const WEBAPP_URL = process.env.WEBAPP_URL; // url миниаппа (Vercel)
const WELCOME_IMAGE_URL = process.env.WELCOME_IMAGE_URL; // картинка приветствия

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env is required");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL env is required");
if (!MANAGER_CHAT_ID) throw new Error("MANAGER_CHAT_ID env is required");
if (!WEBAPP_URL) throw new Error("WEBAPP_URL env is required");
if (!WELCOME_IMAGE_URL) throw new Error("WELCOME_IMAGE_URL env is required");

// topic ids (форум топики)
const TOPIC_ID_WASH = process.env.TOPIC_ID_WASH;
const TOPIC_ID_SERVICE = process.env.TOPIC_ID_SERVICE;
const TOPIC_ID_DETAILING = process.env.TOPIC_ID_DETAILING;
const TOPIC_ID_BODY = process.env.TOPIC_ID_BODY;
const TOPIC_ID_TUNING = process.env.TOPIC_ID_TUNING;

const TOPICS = {
  "Мойка/шиномонтаж": Number(TOPIC_ID_WASH),
  "ТО/Ремонт": Number(TOPIC_ID_SERVICE),
  "Детейлинг": Number(TOPIC_ID_DETAILING),
  "Кузовной ремонт": Number(TOPIC_ID_BODY),
  "Тюнинг": Number(TOPIC_ID_TUNING),
};

// ============ App / Bot ============
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// --- CORS (чтобы Vercel миниапп мог стучаться на Render) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // можно потом заменить на конкретный домен Vercel
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "1mb" }));

const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// ============ Memory Store (MVP) ============
/**
 * requests: id -> request object
 * userRequests: userId -> [requestIds]
 * garages: userId -> { cars: [], activeCarId }
 */
const requests = new Map();
const userRequests = new Map();
const garages = new Map();

// ============ Utils ============
function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function uuid() {
  return crypto.randomUUID();
}

function nowRu() {
  return new Date().toLocaleString("ru-RU");
}

function getGarage(userId) {
  const g = garages.get(String(userId));
  if (g) return g;
  const fresh = { cars: [], activeCarId: null };
  garages.set(String(userId), fresh);
  return fresh;
}

function setUserRequest(userId, requestId) {
  const key = String(userId);
  const arr = userRequests.get(key) || [];
  arr.unshift(requestId);
  userRequests.set(key, arr);
}

function statusLabel(st) {
  if (st === "new") return "🆕 Новая";
  if (st === "inwork") return "🛠️ В работе";
  if (st === "done") return "✅ Готово";
  if (st === "canceled") return "❌ Отменено";
  return st;
}

function managerKeyboard(reqId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ В работу", `req:${reqId}:inwork`),
      Markup.button.callback("✅ Готово", `req:${reqId}:done`),
    ],
    [Markup.button.callback("❌ Отменить", `req:${reqId}:canceled`)],
  ]);
}

async function sendToForumTopic(category, htmlText, extra) {
  const threadId = TOPICS[category];
  if (!threadId) throw new Error(`Unknown category topic: ${category}`);

  return bot.telegram.sendMessage(MANAGER_CHAT_ID, htmlText, {
    parse_mode: "HTML",
    message_thread_id: threadId,
    disable_web_page_preview: true,
    ...extra,
  });
}

// ============ Telegram WebApp initData validation ============
function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function validateInitData(initData) {
  if (!initData || typeof initData !== "string") return { ok: false, error: "initData missing" };

  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) return { ok: false, error: "hash missing" };

  // build data_check_string
  const pairs = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "hash") continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return { ok: false, error: "initData hash invalid" };

  // optional: check auth_date freshness (e.g. 24h)
  const authDate = Number(data.auth_date || 0);
  if (authDate) {
    const ageSec = Math.floor(Date.now() / 1000) - authDate;
    // 7 days
    if (ageSec > 7 * 24 * 3600) return { ok: false, error: "initData expired" };
  }

  // user field is JSON
  let user = null;
  try {
    if (data.user) user = JSON.parse(data.user);
  } catch {
    user = null;
  }

  return { ok: true, user, data };
}

// ============ BOT: /start only ============
bot.start(async (ctx) => {
  const text =
    `🚗 Добрый день, на связи команда Fix Fast.\n` +
    `Мы предоставляем услуги авто-консьерж-сервиса и с радостью решим любой вопрос по обслуживанию вашего автомобиля.\n\n` +
    `Оформите заявку в мини-приложении — менеджер быстро возьмёт её в работу 👇`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.webApp("🚀 Открыть приложение", WEBAPP_URL)],
  ]);

  try {
    await ctx.replyWithPhoto(WELCOME_IMAGE_URL, {
      caption: text,
      ...kb,
    });
  } catch (e) {
    // если фото не загрузилось по URL — fallback на текст
    await ctx.reply(text, kb);
  }
});

// ============ Manager callbacks (status updates) ============
bot.action(/^req:([a-f0-9-]+):(inwork|done|canceled)$/i, async (ctx) => {
  const reqId = ctx.match[1];
  const newStatus = ctx.match[2];

  const req = requests.get(reqId);
  if (!req) {
    await ctx.answerCbQuery("Заявка не найдена");
    return;
  }

  req.status = newStatus;
  req.updatedAt = Date.now();

  // Обновим подпись/текст сообщения менеджерам (edit message)
  const caption =
    `🧾 <b>Заявка</b> — <b>${escapeHtml(req.category)}</b>\n` +
    `Статус: <b>${escapeHtml(statusLabel(req.status))}</b>\n\n` +
    `🚘 <b>Класс:</b> ${escapeHtml(req.carClass)}\n` +
    `🚗 <b>Модель:</b> ${escapeHtml(req.carModel)}\n` +
    `📝 <b>Описание:</b> ${escapeHtml(req.description)}\n\n` +
    `👤 <b>Клиент:</b> ${escapeHtml(req.clientLabel)}\n` +
    `🆔 <b>ID:</b> <code>${escapeHtml(req.id)}</code>\n` +
    `🕒 ${escapeHtml(nowRu())}`;

  // Попробуем edit (в зависимости, фото/текст)
  try {
    const msg = ctx.update?.callback_query?.message;
    if (msg?.photo) {
      await ctx.editMessageCaption(caption, {
        parse_mode: "HTML",
        ...managerKeyboard(req.id),
      });
    } else {
      await ctx.editMessageText(caption, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...managerKeyboard(req.id),
      });
    }
  } catch (e) {
    // если edit нельзя (старое сообщение/права) — просто игнор
  }

  // Уведомим клиента
  const clientMsg =
    `🔔 Ваша заявка по категории «${req.category}» обновлена.\n` +
    `Статус: ${statusLabel(req.status)}\n` +
    `Модель: ${req.carModel}`;

  try {
    await bot.telegram.sendMessage(req.userId, clientMsg, Markup.inlineKeyboard([
      [Markup.button.webApp("Открыть приложение", WEBAPP_URL)],
    ]));
  } catch (e) {
    // если клиент не начинал чат с ботом — отправка может не пройти, ок
  }

  await ctx.answerCbQuery(`Статус: ${statusLabel(newStatus)}`);
});

// ============ API ============
app.get("/", (_, res) => res.status(200).send("OK"));

// Create request from WebApp
app.post("/api/request", async (req, res) => {
  try {
    const { initData, category, carClass, carModel, description, car } = req.body || {};

    const v = validateInitData(initData);
    if (!v.ok) return res.status(401).json({ ok: false, error: v.error });

    const user = v.user;
    if (!user?.id) return res.status(401).json({ ok: false, error: "user missing" });

    if (!category || !carClass || !carModel || !description) {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    if (!TOPICS[category]) {
      return res.status(400).json({ ok: false, error: "unknown category" });
    }

    const id = uuid();

    const clientLabel =
      `${user.first_name || ""}` +
      (user.last_name ? ` ${user.last_name}` : "") +
      (user.username ? ` (@${user.username})` : "");

    const reqObj = {
      id,
      userId: String(user.id),
      clientLabel,
      category,
      carClass,
      carModel,
      description,
      car: car || null,
      status: "new",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    requests.set(id, reqObj);
    setUserRequest(user.id, id);

    const html =
      `🧾 <b>Заявка</b> — <b>${escapeHtml(category)}</b>\n` +
      `Статус: <b>${escapeHtml(statusLabel(reqObj.status))}</b>\n\n` +
      `🚘 <b>Класс:</b> ${escapeHtml(carClass)}\n` +
      `🚗 <b>Модель:</b> ${escapeHtml(carModel)}\n` +
      `📝 <b>Описание:</b> ${escapeHtml(description)}\n\n` +
      `👤 <b>Клиент:</b> ${escapeHtml(clientLabel)}\n` +
      `🆔 <b>ID:</b> <code>${escapeHtml(id)}</code>\n` +
      `🕒 ${escapeHtml(nowRu())}`;

    await sendToForumTopic(category, html, managerKeyboard(id));

    return res.json({ ok: true, id });
  } catch (e) {
    console.error("POST /api/request error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// list my requests
app.post("/api/my-requests", (req, res) => {
  try {
    const { initData } = req.body || {};
    const v = validateInitData(initData);
    if (!v.ok) return res.status(401).json({ ok: false, error: v.error });

    const user = v.user;
    if (!user?.id) return res.status(401).json({ ok: false, error: "user missing" });

    const ids = userRequests.get(String(user.id)) || [];
    const items = ids
      .map((id) => requests.get(id))
      .filter(Boolean)
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        category: r.category,
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
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// garage get
app.post("/api/garage/get", (req, res) => {
  try {
    const { initData } = req.body || {};
    const v = validateInitData(initData);
    if (!v.ok) return res.status(401).json({ ok: false, error: v.error });
    const user = v.user;
    if (!user?.id) return res.status(401).json({ ok: false, error: "user missing" });

    const g = getGarage(user.id);
    return res.json({ ok: true, garage: g });
  } catch (e) {
    console.error("POST /api/garage/get error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// garage add
app.post("/api/garage/add", (req, res) => {
  try {
    const { initData, car } = req.body || {};
    const v = validateInitData(initData);
    if (!v.ok) return res.status(401).json({ ok: false, error: v.error });
    const user = v.user;
    if (!user?.id) return res.status(401).json({ ok: false, error: "user missing" });

    if (!car?.title || !car?.carClass) return res.status(400).json({ ok: false, error: "car fields missing" });

    const g = getGarage(user.id);
    const newCar = {
      id: uuid(),
      title: String(car.title).trim(),
      carClass: String(car.carClass).trim(),
    };

    g.cars.unshift(newCar);
    if (!g.activeCarId) g.activeCarId = newCar.id;

    return res.json({ ok: true, garage: g });
  } catch (e) {
    console.error("POST /api/garage/add error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// garage set active
app.post("/api/garage/active", (req, res) => {
  try {
    const { initData, carId } = req.body || {};
    const v = validateInitData(initData);
    if (!v.ok) return res.status(401).json({ ok: false, error: v.error });
    const user = v.user;
    if (!user?.id) return res.status(401).json({ ok: false, error: "user missing" });

    const g = getGarage(user.id);
    if (!g.cars.find((c) => c.id === carId)) return res.status(400).json({ ok: false, error: "car not found" });

    g.activeCarId = carId;
    return res.json({ ok: true, garage: g });
  } catch (e) {
    console.error("POST /api/garage/active error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// garage delete
app.post("/api/garage/delete", (req, res) => {
  try {
    const { initData, carId } = req.body || {};
    const v = validateInitData(initData);
    if (!v.ok) return res.status(401).json({ ok: false, error: v.error });
    const user = v.user;
    if (!user?.id) return res.status(401).json({ ok: false, error: "user missing" });

    const g = getGarage(user.id);
    g.cars = g.cars.filter((c) => c.id !== carId);
    if (g.activeCarId === carId) g.activeCarId = g.cars[0]?.id || null;

    return res.json({ ok: true, garage: g });
  } catch (e) {
    console.error("POST /api/garage/delete error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ============ WEBHOOK ============
app.use(bot.webhookCallback(WEBHOOK_PATH));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("Webhook set to:", WEBHOOK_URL);
  } catch (e) {
    console.error("Failed to set webhook:", e);
  }
  console.log("Server listening on port:", PORT);
});
