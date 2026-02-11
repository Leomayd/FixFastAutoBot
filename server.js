import express from "express";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // например: https://your-service.onrender.com
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // id форум-чата (где топики)

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env is required");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL env is required");
if (!ADMIN_CHAT_ID) throw new Error("ADMIN_CHAT_ID env is required");

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

const WEBHOOK_PATH = `/telegraf/${BOT_TOKEN}`;
const WEBHOOK_URL = `${PUBLIC_URL}${WEBHOOK_PATH}`;

// ====== ТВОИ ТОПИКИ (из твоего сообщения) ======
const TOPICS = {
  wash_tires: 2,     // мойка / шиномонтаж
  service: 4,        // ТО/Ремонт
  detailing: 6,      // детейлинг
  bodywork: 8,       // кузовной ремонт
  tuning: 10         // тюнинг
};

// ====== УТИЛИТЫ ======
function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

// ====== КНОПКИ ВЫБОРА УСЛУГИ ======
const serviceKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("🧼 Мойка / Шиномонтаж", "svc:wash_tires")],
  [Markup.button.callback("🔧 ТО / Ремонт", "svc:service")],
  [Markup.button.callback("✨ Детейлинг", "svc:detailing")],
  [Markup.button.callback("🎨 Кузовной ремонт", "svc:bodywork")],
  [Markup.button.callback("⚙️ Тюнинг", "svc:tuning")]
]);

// ====== ПАМЯТЬ ДИАЛОГА (in-memory, для MVP) ======
const userState = new Map(); // userId -> { step, topicKey, data }

function setState(userId, patch) {
  const prev = userState.get(userId) || {};
  userState.set(userId, { ...prev, ...patch });
}

function clearState(userId) {
  userState.delete(userId);
}

// ====== BOT FLOW ======
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
      console.error("Failed to send заявку:", e);
      await ctx.reply("❌ Не смог отправить заявку. Попробуй ещё раз или напиши админу.");
    } finally {
      clearState(ctx.from.id);
    }
  }
});

// ====== WEBHOOK ======
app.use(bot.webhookCallback(WEBHOOK_PATH));

// healthcheck
app.get("/", (_, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  // Важно: поднимем вебхук ДО старта сервера — Telegraf норм, но лучше после listen
  app.listen(PORT, async () => {
    try {
      await bot.telegram.setWebhook(WEBHOOK_URL);
      console.log("Webhook set to:", WEBHOOK_URL);
      console.log("Server listening on port:", PORT);
    } catch (e) {
      console.error("Failed to set webhook:", e);
    }
  });
}

bootstrap();
