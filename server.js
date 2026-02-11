// server.js
import express from "express";

const app = express();

/**
 * ====== CORS + preflight (чтобы Telegram WebApp / браузер не падал с "Load failed") ======
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // для WebApp проще так
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));

/**
 * ====== ENV ======
 */
function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const BOT_TOKEN = requiredEnv("BOT_TOKEN");
const MANAGER_CHAT_ID = requiredEnv("MANAGER_CHAT_ID"); // супергруппа -100...
// Топики:
const THREAD_WASH = Number(requiredEnv("THREAD_WASH")); // мойка/шиномонтаж = 2
const THREAD_TO = Number(requiredEnv("THREAD_TO")); // ТО/ремонт = 4
const THREAD_DETAIL = Number(requiredEnv("THREAD_DETAIL")); // детейлинг = 6
const THREAD_BODY = Number(requiredEnv("THREAD_BODY")); // кузовной = 8
const THREAD_TUNING = Number(requiredEnv("THREAD_TUNING")); // тюнинг = 10

const PORT = process.env.PORT || 10000;

const CATEGORY_TO_THREAD = {
  "Мойка/шиномонтаж": THREAD_WASH,
  "ТО/Ремонт": THREAD_TO,
  "Детейлинг": THREAD_DETAIL,
  "Кузовной ремонт": THREAD_BODY,
  "Тюнинг": THREAD_TUNING,
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function tgSendMessage({ chat_id, text, message_thread_id }) {
  const url = https://api.telegram.org/bot${BOT_TOKEN}/sendMessage;

  const payload = {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  // ВНИМАНИЕ: message_thread_id добавляем только если он есть
  if (message_thread_id) payload.message_thread_id = message_thread_id;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.ok) {
    const msg = data?.description || Telegram API error, status=${r.status};
    throw new Error(msg);
  }
  return data.result;
}

/**
 * ====== Health ======
 */
app.get("/api/health", (req, res) => {
  res.status(200).send("ok");
});

/**
 * ====== Main endpoint ======
 * Ожидаем:
 * {
 *   category: "ТО/Ремонт" | ...,
 *   carClass: "Бизнес",
 *   carModel: "BMW 5",
 *   description: "...",
 *   tgUser: { id, first_name, username }  // можно слать из миниаппа
 * }
 */
app.post("/api/request", async (req, res) => {
  try {
    const { category, carClass, carModel, description, tgUser } = req.body || {};

    const cat = String(category || "").trim();
    const cls = String(carClass || "").trim();
    const model = String(carModel || "").trim();
    const desc = String(description || "").trim();

    if (!cat  !cls  !model || !desc) {
      return res.status(400).json({
        ok: false,
        error: "Missing fields: category, carClass, carModel, description are required",
      });
    }

    const threadId = CATEGORY_TO_THREAD[cat] || null;

    const userFirst = tgUser?.first_name ? esc(tgUser.first_name) : "—";
    const userName = tgUser?.username ? "@" + esc(tgUser.username) : "—";
    const userId = tgUser?.id ? esc(tgUser.id) : "—";

    const text =
      <b>Новая заявка</b>\n +
      <b>Категория:</b> ${esc(cat)}\n +
      <b>Класс:</b> ${esc(cls)}\n +
      <b>Марка/модель:</b> ${esc(model)}\n +
      <b>Описание:</b> ${esc(desc)}\n\n +
      <b>Клиент:</b> ${userFirst}\n +
      <b>Username:</b> ${userName}\n +
      <b>User ID:</b> ${userId};

    // 1) Отправляем менеджерам (в супергруппу, в нужный топик)
    await tgSendMessage({
      chat_id: MANAGER_CHAT_ID,
      message_thread_id: threadId, // вот здесь ключ
      text,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("ERR /api/request:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
