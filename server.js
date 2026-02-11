import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// === CONFIG ===
const BOT_TOKEN = process.env.BOT_TOKEN; // токен бота из BotFather
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID; // твой chat_id (куда слать заявки)

async function tgSendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) throw new Error("Telegram sendMessage failed: " + res.status);
  return res.json();
}

// healthcheck
app.get("/", (_, res) => res.send("OK"));

// endpoint called from Mini App
app.post("/api/request", async (req, res) => {
  try {
    const { category, carClass, carModel, description, tgUser } = req.body ?? {};
    if (!category || !carClass || !carModel || !description) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }

    const name = tgUser ? [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") : "—";
    const username = tgUser?.username ? `@${tgUser.username}` : "—";
    const userId = tgUser?.id ?? "—";

    const text =
`<b>Новая заявка</b>
<b>Категория:</b> ${escapeHtml(category)}
<b>Класс:</b> ${escapeHtml(carClass)}
<b>Марка/модель:</b> ${escapeHtml(carModel)}
<b>Описание:</b> ${escapeHtml(description)}

<b>Клиент:</b> ${escapeHtml(name)}
<b>Username:</b> ${escapeHtml(username)}
<b>User ID:</b> ${userId}`;

    await tgSendMessage(MANAGER_CHAT_ID, text);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<"
