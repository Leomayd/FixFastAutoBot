import express from "express";
import fetch from "node-fetch";

const app = express();

// Важно: разрешаем запросы из мини-аппа (браузер внутри Telegram)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// === ENV ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

function requiredEnv() {
  if (!BOT_TOKEN) throw new Error("Missing env BOT_TOKEN");
  if (!MANAGER_CHAT_ID || MANAGER_CHAT_ID === "0") throw new Error("Missing env MANAGER_CHAT_ID");
}

async function tgSendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error("Telegram sendMessage failed: " + JSON.stringify(data));
  }
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// healthcheck
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// endpoint called from Mini App
app.post("/api/request", async (req, res) => {
  try {
    requiredEnv();

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

    return res.json({ ok: true });
  } catch (e) {
    console.error("ERR /api/request:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Render сам задаёт PORT
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log("Server listening on port", port);
});
