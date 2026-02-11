import express from "express";
import { Telegraf, Markup } from "telegraf";

// ===== ENV (trim!) =====
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim(); // важно: без \n
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || "").trim();

// Топики из Render env (как у тебя на скрине)
const TOPIC_ID_WASH = (process.env.TOPIC_ID_WASH || "").trim();
const TOPIC_ID_SERVICE = (process.env.TOPIC_ID_SERVICE || "").trim();
const TOPIC_ID_DETAILING = (process.env.TOPIC_ID_DETAILING || "").trim();
const TOPIC_ID_BODY = (process.env.TOPIC_ID_BODY || "").trim();
const TOPIC_ID_TUNING = (process.env.TOPIC_ID_TUNING || "").trim();

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env is required");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL env is required");
if (!ADMIN_CHAT_ID) throw new Error("ADMIN_CHAT_ID env is required");

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CORS (для Telegram WebApp) =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // можно ужесточить позже
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// ===== TOPICS map =====
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
  // поддержим разные названия из фронта
  if (["wash", "wash_tires", "мойка", "шин", "tires"].some(x => v.includes(x))) return "wash_tires";
  if (["service", "repair", "то", "ремонт"].some(x => v.includes(x))) return "service";
  if (["detailing", "detail", "детейл"].some(x => v.includes(x))) return "detailing";
  if (["body", "bodywork", "кузов"].some(x => v.includes(x))) return "bodywork";
  if (["tuning", "тюнинг"].some(x => v.includes(x))) return "tuning";
  return v;
}

async function sendToForumTopic(topicKey, htmlText) {
  const threadId = TOPICS[topicKey];
  if (!threadId) throw new Error(`Unknown topicKey: ${topicKey}`);

  return bot.telegram.sendMessage(ADMIN_CHAT_ID, htmlText, {
    parse_mode: "HTML",
    message_thread_id: threadId,
    disable_web_page_preview: true
  });
}

// ===== MINI-APP API =====
// Ожидаем JSON примерно такой:
// { service: "bodywork", carClass, brandModel, comment, name, phone, tgUser }
async function handleLead(req, res) {
  try {
    const body = req.body || {};
    const serviceKey = normalizeServiceKey(body.service || body.topic || body.type);

    const name = body.name || body.clientName || "";
    const phone = body.phone || body.clientPhone || "";
    const comment = body.comment || body.description || "";
    const carClass = body.carClass || body.class || "";
    const brandModel = body.brandModel || body.model || body.car || "";

    // tg initData user (если фронт присылает)
    const tgUser = body.tgUser || body.user || null;
    const who = tgUser
      ? `${escapeHtml(tgUser.first_name || "")}${tgUser.last_name ? " " + escapeHtml(tgUser.last_name) : ""}${tgUser.username ? " (@" + escapeHtml(tgUser.username) + ")" : ""}`
      : "WebApp";

    const html =
      `🆕 <b>Новая заявка</b>\n` +
      `🧩 <b>Раздел:</b> ${escapeHtml(serviceKey)}\n` +
      `👤 ${who}\n` +
      (carClass ? `🚘 <b>Класс:</b> ${escapeHtml(carClass)}\n` : "") +
      (brandModel ? `🏷️ <b>Марка/модель:</b> ${escapeHtml(brandModel)}\n` : "") +
      (name ? `🧾 <b>Имя:</b> ${escapeHtml(name)}\n` : "") +
      (phone ? `📞 <b>Телефон:</b> ${escapeHtml(phone)}\n` : "") +
      (comment ? `💬 <b>Комментарий:</b> ${escapeHtml(comment)}\n` : "") +
      `🕒 ${escapeHtml(new Date().toLocaleString("ru-RU"))}`;

    await sendToForumTopic(serviceKey, html);

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("LEAD ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// несколько путей, чтобы точно совпасть с твоим фронтом
app.post("/lead", handleLead);
app.post("/submit", handleLead);
app.post("/api/lead", handleLead);
app.post("/api/submit", handleLead);

// ===== BOT FLOW (оставляем) =====
const serviceKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("🧼 Мойка / Шиномонтаж", "svc:wash_tires")],
  [Markup.button.callback("🔧 ТО / Ремонт", "svc:service")],
  [Markup.button.callback("✨ Детейлинг", "svc:detailing")],
  [Markup.button.callback("🎨 Кузовной ремонт", "svc:bodywork")],
  [Markup.button.callback("⚙️ Тюнинг", "svc:tuning")]
]);

const userState = new Map();

function setState(userId, patch) {
  const prev = userState.get(userId) || {};
  userState.set(userId, { ...prev, ...patch });
}
function clearState(userId) {
  userState.delete(userId);
}

bot.start(async (ctx) => {
  clearState(ctx.from.id);
  await ctx.reply("Выбери услугу, чтобы оставить заявку 👇", serviceKeyboard);
});

bot.action(/^svc:(.+)$/i, async (ctx) => {
  const topicKey = ctx.match[1];
  if (!TOPICS[topicKey]) {
    await ctx.answerCbQuery("Неизвестный раздел");
    return;
  }
  setState(ctx.from.id, { step: "name", topicKey, data: {} });
  await ctx.answerCbQuery("Ок");
  await ctx.reply("Как вас зовут?");
});

bot.on("text", async (ctx) => {
  const st = userState.get(ctx.from.id);
  if (!st) {
    await ctx.reply("Нажми /start и выбери услугу 👇");
    return;
  }

  const text = ctx.message.text.trim();

  if (st.step === "name") {
    setState(ctx.from.id, { step: "phone", data: { ...st.data, name: text } });
    await ctx.reply("Телефон для связи?");
    return;
  }

  if (st.step === "phone") {
    setState(ctx.from.id, { step: "comment", data: { ...st.data, phone: text } });
    await ctx.reply("Комментарий к заявке (что нужно сделать)?");
    return;
  }

  if (st.step === "comment") {
    const data = { ...st.data, comment: text };
    const user = ctx.from;

    const who =
      `${escapeHtml(user.first_name || "")}` +
      (user.last_name ? ` ${escapeHtml(user.last_name)}` : "") +
      (user.username ? ` (@${escapeHtml(user.username)})` : "");

    const html =
      `🆕 <b>Новая заявка</b>\n` +
      `👤 ${who}\n` +
      `🧾 <b>Имя:</b> ${escapeHtml(data.name)}\n` +
      `📞 <b>Телефон:</b> ${escapeHtml(data.phone)}\n` +
      `💬 <b>Комментарий:</b> ${escapeHtml(data.comment)}\n` +
      `🕒 ${escapeHtml(new Date().toLocaleString("ru-RU"))}`;

    try {
      await sendToForumTopic(st.topicKey, html);
      await ctx.reply("✅ Заявка отправлена! Скоро с вами свяжутся.");
    } catch (e) {
      console.error("Failed to send from bot flow:", e);
      await ctx.reply("❌ Не смог отправить заявку. Попробуй ещё раз или напиши админу.");
    } finally {
      clearState(ctx.from.id);
    }
  }
});

// webhook callback
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
