import express from "express";
import { Telegraf } from "telegraf";

/**
 * ENV (Render -> Environment Variables)
 *
 * REQUIRED:
 * - BOT_TOKEN
 * - PUBLIC_URL              (например: https://fixfastautobot.onrender.com)
 * - MANAGER_CHAT_ID         (форум-чат id: -100...)
 * - WEBAPP_URL              (url твоего миниаппа, который открывает кнопка)
 *
 * OPTIONAL (если не заданы — будут дефолты 2/4/6/8/10):
 * - TOPIC_ID_WASH
 * - TOPIC_ID_SERVICE
 * - TOPIC_ID_DETAILING
 * - TOPIC_ID_BODY
 * - TOPIC_ID_TUNING
 *
 * OPTIONAL:
 * - WELCOME_IMAGE_URL       (картинка для приветствия: https://...jpg/png)
 */

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
const MANAGER_CHAT_ID = (process.env.MANAGER_CHAT_ID || "").trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || "").trim(); // миниапп URL для кнопки
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

// ===== CORS для Telegram WebApp =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // можно ужесточить позже
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// ===== ТВОИ ТОПИКИ (из env либо дефолт) =====
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

  // если фронт шлёт уже ключи: wash_tires/service/detailing/bodywork/tuning — вернём их
  if (TOPICS[v]) return v;

  // если фронт шлёт русские названия/варианты
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

// =====================================================
// 1) BOT: только приветствие + картинка + кнопка WebApp
// =====================================================
bot.start(async (ctx) => {
  const caption =
    `🚗 <b>FixFast</b>\n` +
    `Авто-консьерж сервис\n\n` +
    `Оформляйте заявку в мини-приложении.\n` +
    `Нажмите кнопку ниже 👇`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🚀 Открыть приложение",
            web_app: { url: WEBAPP_URL }
          }
        ]
      ]
    }
  };

  // Если картинка есть — отправляем фото с подписью
  if (WELCOME_IMAGE_URL) {
    await ctx.replyWithPhoto(
      { url: WELCOME_IMAGE_URL },
      { caption, parse_mode: "HTML", ...keyboard }
    );
    return;
  }

  // Иначе просто текст
  await ctx.reply(caption, { parse_mode: "HTML", ...keyboard });
});

// Всё остальное в чате игнорируем (чтобы не было “ботовых” заявок)
bot.on("message", async (ctx) => {
  // можешь оставить silent, либо мягко направлять:
  // await ctx.reply("Нажмите «Открыть приложение» чтобы оставить заявку 👇");
});

// =====================================================
// 2) MINI-APP API: POST /lead -> отправка в топик
// =====================================================
// Ожидаемый JSON (пример):
// {
//   "service":"bodywork",
//   "carClass":"Бизнес",
//   "brandModel":"BMW 5",
//   "comment":"тест",
//   "name":"Leo",
//   "phone":"8985...",
//   "tgUser": {"id":..., "username":"...", "first_name":"..."}
// }
app.post("/lead", async (req, res) => {
  try {
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
    const who = tgUser
      ? `@${escapeHtml(tgUser.username || "")} (${escapeHtml(tgUser.id)})`
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

// удобные алиасы (если фронт шлёт на другие пути)
app.post("/submit", (req, res) => app._router.handle({ ...req, url: "/lead" }, res));
app.post("/api/lead", (req, res) => app._router.handle({ ...req, url: "/lead" }, res));
app.post("/api/submit", (req, res) => app._router.handle({ ...req, url: "/lead" }, res));

// Webhook endpoint для Telegram
app.use(bot.webhookCallback(WEBHOOK_PATH));

// healthcheck
app.get("/", (_, res) => res.status(200).send("OK"));

// =====================================================
// 3) START
// =====================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  try {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("Server listening on port:", PORT);
    console.log("Webhook set ✅");
  } catch (e) {
    console.error("Failed to set webhook:", e);
  }
});
