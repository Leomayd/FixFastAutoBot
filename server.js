import express from "express";
import crypto from "crypto";
import { Telegraf, Markup } from "telegraf";
import pg from "pg";

console.log("SERVER VERSION: 2026-02-12_fixfast_pg_v2_garage_bonus");

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

const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env is required");
if (!PUBLIC_URL) throw new Error("PUBLIC_URL env is required");
if (!MANAGER_CHAT_ID) throw new Error("MANAGER_CHAT_ID env is required");
if (!WEBAPP_URL) throw new Error("WEBAPP_URL env is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL env is required");

// =============== APP ===============
const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  next();
});

// CORS (миниапп на Vercel)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// =============== BOT ===============
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

const BONUS_PER_DONE = 1000;

// =============== DB ===============
const { Pool } = pg;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function dbInit() {
  // users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id text PRIMARY KEY,
      username text,
      first_name text,
      active_car_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // cars
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cars (
      id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      title text NOT NULL,
      car_class text NOT NULL,
      plate text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cars_user_id_created_at ON cars (user_id, created_at DESC);`);

  // requests
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      category_key text NOT NULL,
      category_label text NOT NULL,
      car_class text NOT NULL,
      car_model text NOT NULL,
      description text NOT NULL,
      car jsonb,
      status text NOT NULL DEFAULT 'new',
      client_line text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_requests_user_id_created_at ON requests (user_id, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);`);

  // bonus ledger: один done = один бонус-транзакшн (уникально по request_id)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bonus_tx (
      id uuid PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
      delta int NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, request_id, reason)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bonus_tx_user_id_created_at ON bonus_tx (user_id, created_at DESC);`);

  console.log("[DB] init ok");
}

// =============== Telegram initData verify ===============
function parseInitData(initData) {
  const params = new URLSearchParams(initData || "");
  const hash = params.get("hash") || "";
  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return { hash, dataCheckString, params };
}

function verifyInitData(initData) {
  if (!initData) return { ok: false, error: "initData required" };
  const { hash, dataCheckString, params } = parseInitData(initData);

  if (!hash || !dataCheckString) return { ok: false, error: "bad initData" };

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calcHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (calcHash !== hash) return { ok: false, error: "initData hash invalid" };

  // user is JSON in params
  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, error: "no user in initData" };

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, error: "bad user json" };
  }

  const userId = user?.id ? String(user.id) : "";
  if (!userId) return { ok: false, error: "no user.id" };

  return {
    ok: true,
    user: {
      id: userId,
      username: user?.username ? String(user.username) : null,
      first_name: user?.first_name ? String(user.first_name) : null,
    },
  };
}

async function ensureUser(tgUser) {
  const userId = tgUser.id;

  await pool.query(
    `
    INSERT INTO users (user_id, username, first_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      updated_at = now();
  `,
    [userId, tgUser.username, tgUser.first_name]
  );

  const { rows } = await pool.query(`SELECT user_id, username, first_name, active_car_id FROM users WHERE user_id=$1`, [
    userId,
  ]);

  return rows[0];
}

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

function safeUserLine(tgUser) {
  if (!tgUser) return "WebApp";
  const username = tgUser.username ? `@${escapeHtml(tgUser.username)}` : "";
  const id = tgUser.id ? `${escapeHtml(tgUser.id)}` : "";
  if (username && id) return `${username} (${id})`;
  if (username) return username;
  if (id) return id;
  return "WebApp";
}

function buildManagerHtml(r) {
  const car = r.car || null;
  return (
    `🧾 <b>Заявка</b> — <b>${escapeHtml(r.category_label)}</b>\n` +
    `Статус: <b>${escapeHtml(statusLabel(r.status))}</b>\n\n` +
    (car?.title ? `🚗 <b>Авто:</b> ${escapeHtml(car.title)}\n` : "") +
    (car?.plate ? `🔢 <b>Номер:</b> ${escapeHtml(car.plate)}\n` : "") +
    `🚘 <b>Класс:</b> ${escapeHtml(r.car_class)}\n` +
    `🚗 <b>Модель:</b> ${escapeHtml(r.car_model)}\n` +
    `📝 <b>Описание:</b> ${escapeHtml(r.description)}\n\n` +
    `👤 <b>Клиент:</b> ${escapeHtml(r.client_line || "")}\n` +
    `🆔 <b>ID:</b> <code>${escapeHtml(r.id)}</code>\n` +
    `🕒 ${escapeHtml(nowRu())}`
  );
}

async function getBonusPoints(userId) {
  const { rows } = await pool.query(`SELECT COALESCE(SUM(delta),0)::int AS points FROM bonus_tx WHERE user_id=$1`, [
    userId,
  ]);
  return rows[0]?.points ?? 0;
}

async function awardDoneBonusIfNeeded(reqRow) {
  // начисляем только когда статус стал done
  if (reqRow.status !== "done") return;

  // одна транзакция на заявку
  const txId = mkId();
  try {
    await pool.query(
      `INSERT INTO bonus_tx (id, user_id, request_id, delta, reason)
       VALUES ($1, $2, $3, $4, 'done_request');`,
      [txId, reqRow.user_id, reqRow.id, BONUS_PER_DONE]
    );
  } catch (e) {
    // unique violation => уже начисляли, это ок
    if (String(e?.code) !== "23505") throw e;
  }
}

// =============== BOT: /start ===============
async function sendWelcome(ctx) {
  const caption =
    `🚗 <b>Добрый день, на связи команда Fix Fast.</b>\n` +
    `Мы предоставляем услуги авто-консьерж-сервиса и решим любой вопрос по вашему авто.\n\n` +
    `Оформите заявку в мини-приложении — менеджер возьмёт её в работу 👇`;

  const kb = Markup.inlineKeyboard([[Markup.button.webApp("🚀 Открыть приложение", WEBAPP_URL)]]);

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
bot.hears(/^\/start$/i, sendWelcome);
bot.on("message", async () => {});

// manager кнопки статуса
bot.action(/^req:([a-f0-9-]+):(new|inwork|done|canceled)$/i, async (ctx) => {
  const reqId = ctx.match[1];
  const newStatus = ctx.match[2];

  // обновим в БД и вернем строку
  const { rows } = await pool.query(
    `UPDATE requests
     SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING *;`,
    [reqId, newStatus]
  );

  const r = rows[0];
  if (!r) {
    await ctx.answerCbQuery("Заявка не найдена");
    return;
  }

  try {
    if (typeof r.car === "string") r.car = JSON.parse(r.car);
  } catch {}

  // ✅ бонусы — на сервере (тут же, при done)
  try {
    await awardDoneBonusIfNeeded(r);
  } catch (e) {
    console.error("award bonus error:", e);
  }

  // обновим сообщение менеджерам (edit)
  const html = buildManagerHtml(r);

  try {
    await ctx.editMessageText(html, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...managerKeyboard(r.id, r.status),
    });
  } catch (e) {
    console.warn("editMessageText failed:", e?.message || e);
  }

  // пинганём клиента
  try {
    await bot.telegram.sendMessage(
      r.user_id,
      `🔔 Статус вашей заявки обновлён: ${statusLabel(r.status)}\n${r.category_label} • ${r.car_model}`,
      Markup.inlineKeyboard([[Markup.button.webApp("Открыть приложение", WEBAPP_URL)]])
    );
  } catch {}

  await ctx.answerCbQuery(`Статус: ${statusLabel(newStatus)}`);
});

bot.action(/^noop:/i, async (ctx) => {
  await ctx.answerCbQuery("Ок");
});

// =============== API ===============
// health
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/api/ping", (_req, res) => res.json({ ok: true, version: "2026-02-12_fixfast_pg_v2_garage_bonus" }));

function requireAuth(req, res) {
  const initData = req.body?.initData || "";
  const v = verifyInitData(initData);
  if (!v.ok) {
    res.status(401).json({ ok: false, error: v.error || "unauthorized" });
    return null;
  }
  return v.user;
}

// профиль: user + cars + active + points
app.post("/api/profile", async (req, res) => {
  try {
    const tgUser = requireAuth(req, res);
    if (!tgUser) return;

    const userRow = await ensureUser(tgUser);

    const { rows: carRows } = await pool.query(
      `SELECT id, title, car_class, plate
       FROM cars
       WHERE user_id=$1
       ORDER BY created_at DESC`,
      [tgUser.id]
    );

    const points = await getBonusPoints(tgUser.id);

    return res.json({
      ok: true,
      user: { id: tgUser.id, username: tgUser.username, first_name: tgUser.first_name },
      garage: carRows.map((c) => ({
        id: c.id,
        title: c.title,
        carClass: c.car_class,
        plate: c.plate || "",
      })),
      activeCarId: userRow?.active_car_id || "",
      points,
    });
  } catch (e) {
    console.error("POST /api/profile error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// garage add
app.post("/api/garage/add", async (req, res) => {
  try {
    const tgUser = requireAuth(req, res);
    if (!tgUser) return;

    await ensureUser(tgUser);

    const title = String(req.body?.title || "").trim();
    const carClass = String(req.body?.carClass || "").trim();
    const plate = String(req.body?.plate || "").trim();

    if (!title || !carClass) return res.status(400).json({ ok: false, error: "title and carClass required" });

    const id = mkId();

    await pool.query(`INSERT INTO cars (id, user_id, title, car_class, plate) VALUES ($1,$2,$3,$4,$5)`, [
      id,
      tgUser.id,
      title,
      carClass,
      plate || "",
    ]);

    // если active_car_id пуст — делаем этот авто активным
    const { rows } = await pool.query(`SELECT active_car_id FROM users WHERE user_id=$1`, [tgUser.id]);
    const active = rows[0]?.active_car_id || null;
    if (!active) {
      await pool.query(`UPDATE users SET active_car_id=$2, updated_at=now() WHERE user_id=$1`, [tgUser.id, id]);
    }

    return res.json({ ok: true, id });
  } catch (e) {
    console.error("POST /api/garage/add error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// set active
app.post("/api/garage/set-active", async (req, res) => {
  try {
    const tgUser = requireAuth(req, res);
    if (!tgUser) return;

    await ensureUser(tgUser);

    const carId = String(req.body?.carId || "").trim();
    if (!carId) return res.status(400).json({ ok: false, error: "carId required" });

    // проверим что авто принадлежит пользователю
    const { rows: cars } = await pool.query(`SELECT id FROM cars WHERE id=$1 AND user_id=$2`, [carId, tgUser.id]);
    if (!cars[0]) return res.status(403).json({ ok: false, error: "forbidden" });

    await pool.query(`UPDATE users SET active_car_id=$2, updated_at=now() WHERE user_id=$1`, [tgUser.id, carId]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/garage/set-active error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// delete car
app.post("/api/garage/delete", async (req, res) => {
  try {
    const tgUser = requireAuth(req, res);
    if (!tgUser) return;

    await ensureUser(tgUser);

    const carId = String(req.body?.carId || "").trim();
    if (!carId) return res.status(400).json({ ok: false, error: "carId required" });

    await pool.query(`DELETE FROM cars WHERE id=$1 AND user_id=$2`, [carId, tgUser.id]);

    // если удалили активное — поставим новое активное (последнее созданное)
    const { rows: uRows } = await pool.query(`SELECT active_car_id FROM users WHERE user_id=$1`, [tgUser.id]);
    const active = uRows[0]?.active_car_id ? String(uRows[0].active_car_id) : "";

    if (active && active === carId) {
      const { rows: nextCars } = await pool.query(
        `SELECT id FROM cars WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [tgUser.id]
      );
      const nextId = nextCars[0]?.id || null;
      await pool.query(`UPDATE users SET active_car_id=$2, updated_at=now() WHERE user_id=$1`, [tgUser.id, nextId]);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/garage/delete error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// create request (from miniapp)
app.post("/api/request", async (req, res) => {
  try {
    const tgUser = requireAuth(req, res);
    if (!tgUser) return;

    await ensureUser(tgUser);

    const body = req.body || {};
    const topicKey = mapCategoryToTopicKey(body.category);
    if (!topicKey) return res.status(400).json({ ok: false, error: "Unknown category" });

    const categoryLabel = body.category || LABELS[topicKey] || topicKey;

    const carClass = String(body.carClass || "").trim();
    const carModel = String(body.carModel || "").trim();
    const description = String(body.description || "").trim();
    if (!carModel || !description) return res.status(400).json({ ok: false, error: "Missing fields" });

    const car = body.car || null;

    const reqId = mkId();
    const clientLine = safeUserLine(tgUser);

    await pool.query(
      `INSERT INTO requests
       (id, user_id, category_key, category_label, car_class, car_model, description, car, status, client_line)
       VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, 'new', $9);`,
      [reqId, tgUser.id, topicKey, String(categoryLabel), carClass, carModel, description, car, clientLine]
    );

    const html =
      `🧾 <b>Заявка</b> — <b>${escapeHtml(String(categoryLabel))}</b>\n` +
      `Статус: <b>${escapeHtml(statusLabel("new"))}</b>\n\n` +
      (car?.title ? `🚗 <b>Авто:</b> ${escapeHtml(car.title)}\n` : "") +
      (car?.plate ? `🔢 <b>Номер:</b> ${escapeHtml(car.plate)}\n` : "") +
      `🚘 <b>Класс:</b> ${escapeHtml(carClass)}\n` +
      `🚗 <b>Модель:</b> ${escapeHtml(carModel)}\n` +
      `📝 <b>Описание:</b> ${escapeHtml(description)}\n\n` +
      `👤 <b>Клиент:</b> ${escapeHtml(clientLine)}\n` +
      `🆔 <b>ID:</b> <code>${escapeHtml(reqId)}</code>\n` +
      `🕒 ${escapeHtml(nowRu())}`;

    await sendToForumTopic(topicKey, html, managerKeyboard(reqId, "new"));

    return res.json({ ok: true, id: reqId });
  } catch (e) {
    console.error("POST /api/request error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// list my requests
app.post("/api/my-requests", async (req, res) => {
  try {
    const tgUser = requireAuth(req, res);
    if (!tgUser) return;

    await ensureUser(tgUser);

    const { rows } = await pool.query(
      `SELECT id, category_label, car_class, car_model, description, status, created_at, updated_at
       FROM requests
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50;`,
      [tgUser.id]
    );

    const items = rows.map((r) => ({
      id: r.id,
      category: r.category_label,
      carClass: r.car_class,
      carModel: r.car_model,
      description: r.description,
      status: r.status,
      createdAt: new Date(r.created_at).getTime(),
      updatedAt: new Date(r.updated_at).getTime(),
    }));

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("POST /api/my-requests error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// webhook
app.post(WEBHOOK_PATH, bot.webhookCallback(WEBHOOK_PATH));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  try {
    await dbInit();
  } catch (e) {
    console.error("[DB] init failed:", e);
    process.exit(1);
  }

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
