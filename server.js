"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const Database = require("better-sqlite3");
const { rateLimit } = require("express-rate-limit");

const ROOT = __dirname;
const PRODUCT_IMAGE_DIR = path.join(ROOT, "product-images");
const MAX_PRODUCT_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_PRODUCT_IMAGES = 5;
const WHEEL_SPIN_COST = 10;
const WHEEL_PROBABILITY_TOTAL = 10000;
const WHEEL_TOPUP_PACKAGES = [10000, 20000, 50000, 100000];
const WHEEL_TOPUP_DATABASE_PACKAGES = [...WHEEL_TOPUP_PACKAGES, 200000];
const WHEEL_TOPUP_DATABASE_POINTS = WHEEL_TOPUP_DATABASE_PACKAGES.map((amount) => amount / 1000);
fs.mkdirSync(PRODUCT_IMAGE_DIR, { recursive: true });

function loadEnvironment() {
  const envFile = path.join(ROOT, ".env");
  if (!fs.existsSync(envFile)) return;
  for (const rawLine of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvironment();

function configuredValue(encodedName, plainName) {
  const encoded = process.env[encodedName];
  if (encoded) return Buffer.from(encoded, "base64").toString("utf8");
  return process.env[plainName] || "";
}

const port = Number(process.env.PORT || 3000);
const adminUsername = configuredValue("ADMIN_USERNAME_B64", "ADMIN_USERNAME");
const adminPasswordHashText = process.env.ADMIN_PASSWORD_HASH || "";
const adminPasswordSaltText = process.env.ADMIN_PASSWORD_SALT || "";
const encryptionKeyText = process.env.ACCOUNT_ENCRYPTION_KEY || "";
const customerPasswordIterations = 310000;
const bankCode = process.env.BANK_CODE || "";
const bankAccount = process.env.BANK_ACCOUNT || "";
const bankAccountName = configuredValue("BANK_ACCOUNT_NAME_B64", "BANK_ACCOUNT_NAME");

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
if (adminUsername.length < 3) throw new Error("Set ADMIN_USERNAME (at least 3 characters) in .env.");
if (!/^[a-f\d]{64}$/i.test(adminPasswordHashText) || !/^[a-f\d]{32}$/i.test(adminPasswordSaltText)) {
  throw new Error("Set ADMIN_PASSWORD_HASH and ADMIN_PASSWORD_SALT in .env.");
}
if (!/^[a-f\d]{64}$/i.test(encryptionKeyText)) throw new Error("Set ACCOUNT_ENCRYPTION_KEY to 64 hexadecimal characters in .env.");
if ((bankCode || bankAccount || bankAccountName) && !(bankCode && bankAccount && bankAccountName)) {
  throw new Error("Set BANK_CODE, BANK_ACCOUNT, and BANK_ACCOUNT_NAME together, or leave all three empty.");
}
if (bankCode && !/^[a-z\d-]{2,24}$/i.test(bankCode)) throw new Error("BANK_CODE has an invalid format.");
if (bankAccount && !/^[\d]{6,24}$/.test(bankAccount)) throw new Error("BANK_ACCOUNT must contain 6-24 digits.");

const key = Buffer.from(encryptionKeyText, "hex");
const adminPasswordSalt = Buffer.from(adminPasswordSaltText, "hex");
const adminPasswordHash = Buffer.from(adminPasswordHashText, "hex");
const db = new Database(path.resolve(process.env.STORE_DB_PATH || path.join(ROOT, "store.sqlite")));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS customer_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer_sessions (
    token_digest TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customer_accounts(id),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer_wallets (
    customer_id INTEGER PRIMARY KEY REFERENCES customer_accounts(id),
    balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
  );
  CREATE TABLE IF NOT EXISTS customer_point_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customer_accounts(id),
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
    reason TEXT NOT NULL CHECK (reason IN ('topup', 'spin')),
    reference TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (reason, reference)
  );
  CREATE TABLE IF NOT EXISTS point_topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    customer_id INTEGER NOT NULL REFERENCES customer_accounts(id),
    amount INTEGER NOT NULL CHECK (amount IN (${WHEEL_TOPUP_DATABASE_PACKAGES.join(", ")})),
    points INTEGER NOT NULL CHECK (points IN (${WHEEL_TOPUP_DATABASE_POINTS.join(", ")})),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS wheel_prizes (
    product_id INTEGER PRIMARY KEY REFERENCES products(id),
    probability INTEGER NOT NULL CHECK (probability > 0 AND probability <= 10000)
  );
  CREATE TABLE IF NOT EXISTS wheel_spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customer_accounts(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    product_name TEXT NOT NULL,
    ovr INTEGER NOT NULL,
    username_cipher TEXT NOT NULL,
    password_cipher TEXT NOT NULL,
    points_spent INTEGER NOT NULL CHECK (points_spent > 0),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ovr INTEGER NOT NULL CHECK (ovr BETWEEN 1 AND 200),
    price INTEGER NOT NULL CHECK (price > 0),
    description TEXT NOT NULL,
    login_cipher TEXT NOT NULL,
    password_cipher TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold', 'archived')),
    created_at TEXT NOT NULL,
    image_path TEXT
  );
  CREATE TABLE IF NOT EXISTS orders (
    code TEXT PRIMARY KEY,
    customer_id INTEGER REFERENCES customer_accounts(id),
    customer_name_cipher TEXT NOT NULL,
    phone_cipher TEXT NOT NULL,
    phone_digest TEXT NOT NULL,
    total INTEGER NOT NULL CHECK (total > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled', 'expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT NOT NULL REFERENCES orders(code),
    product_id INTEGER NOT NULL REFERENCES products(id),
    product_name TEXT NOT NULL,
    ovr INTEGER NOT NULL,
    login_cipher TEXT NOT NULL,
    password_cipher TEXT NOT NULL,
    UNIQUE (order_code, product_id)
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_digest TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    image_path TEXT NOT NULL,
    position INTEGER NOT NULL,
    UNIQUE (product_id, image_path)
  );
  CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_customer_sessions_expiry ON customer_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_point_topups_customer ON point_topups(customer_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_point_topups_status ON point_topups(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_wheel_spins_customer ON wheel_spins(customer_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, position, id);
`);
const topupTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'point_topups'").get()?.sql || "";
if (!topupTableSql.includes(`amount INTEGER NOT NULL CHECK (amount IN (${WHEEL_TOPUP_DATABASE_PACKAGES.join(", ")}))`)
  || !topupTableSql.includes(`points INTEGER NOT NULL CHECK (points IN (${WHEEL_TOPUP_DATABASE_POINTS.join(", ")}))`)) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE point_topups_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customer_accounts(id),
        amount INTEGER NOT NULL CHECK (amount IN (${WHEEL_TOPUP_DATABASE_PACKAGES.join(", ")})),
        points INTEGER NOT NULL CHECK (points IN (${WHEEL_TOPUP_DATABASE_POINTS.join(", ")})),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      INSERT INTO point_topups_new (id, code, customer_id, amount, points, status, created_at, reviewed_at)
      SELECT id, code, customer_id, amount, points, status, created_at, reviewed_at FROM point_topups;
      DROP TABLE point_topups;
      ALTER TABLE point_topups_new RENAME TO point_topups;
    `);
  })();
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_one_pending_topup ON point_topups(customer_id) WHERE status = 'pending'");
if (!db.prepare("PRAGMA table_info(orders)").all().some((column) => column.name === "customer_id")) {
  db.exec("ALTER TABLE orders ADD COLUMN customer_id INTEGER REFERENCES customer_accounts(id)");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at)");
if (!db.prepare("PRAGMA table_info(products)").all().some((column) => column.name === "image_path")) {
  db.exec("ALTER TABLE products ADD COLUMN image_path TEXT");
}
db.prepare(`
  INSERT OR IGNORE INTO product_images (product_id, image_path, position)
  SELECT id, image_path, 0 FROM products WHERE image_path IS NOT NULL
`).run();

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

function decrypt(value) {
  const [ivText, tagText, ciphertextText] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "hex"));
  decipher.setAuthTag(Buffer.from(tagText, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "hex")), decipher.final()]).toString("utf8");
}

function phoneDigest(phone) {
  return crypto.createHmac("sha256", key).update(phone).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/[\s().-]/g, "");
  const normalized = digits.startsWith("+84") ? `0${digits.slice(3)}` : digits.startsWith("84") ? `0${digits.slice(2)}` : digits;
  return /^0\d{9,10}$/.test(normalized) ? normalized : "";
}

function toSqliteDate(value) {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function expireOrders() {
  const now = toSqliteDate(new Date());
  const stale = db.prepare("SELECT code FROM orders WHERE status = 'pending' AND expires_at <= ?").all(now);
  const expire = db.transaction((orders) => {
    const release = db.prepare("UPDATE products SET status = 'available' WHERE id = ? AND status = 'reserved'");
    const markExpired = db.prepare("UPDATE orders SET status = 'expired' WHERE code = ? AND status = 'pending'");
    const items = db.prepare("SELECT product_id FROM order_items WHERE order_code = ?");
    for (const order of orders) {
      for (const item of items.all(order.code)) release.run(item.product_id);
      markExpired.run(order.code);
    }
  });
  expire(stale);
}

function orderCode() {
  return `FC${new Date().toISOString().slice(2, 10).replaceAll("-", "")}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function safeProduct(row) {
  const images = (row.images || (row.image_path ? [row.image_path] : [])).map((image) => typeof image === "string" ? image : image.image_path);
  return { id: row.id, name: row.name, ovr: row.ovr, price: row.price, description: row.description, imagePath: images[0] || null, images };
}

function attachProductImages(products) {
  if (products.length === 0) return [];
  const placeholders = products.map(() => "?").join(",");
  const imageRows = db.prepare(`
    SELECT id, product_id, image_path FROM product_images
    WHERE product_id IN (${placeholders}) ORDER BY position, id
  `).all(...products.map((product) => product.id));
  const imagesByProduct = new Map();
  for (const image of imageRows) {
    if (!imagesByProduct.has(image.product_id)) imagesByProduct.set(image.product_id, []);
    imagesByProduct.get(image.product_id).push({ id: image.id, image_path: image.image_path });
  }
  return products.map((product) => ({
    ...product,
    images: imagesByProduct.get(product.id) || (product.image_path ? [product.image_path] : [])
  }));
}

function saveProductImage(file) {
  const { buffer } = file;
  let extension = null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) extension = "jpg";
  else if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) extension = "png";
  else if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") extension = "webp";
  if (!extension) {
    const error = new Error("Tệp tải lên không phải ảnh JPG, PNG hoặc WebP hợp lệ.");
    error.status = 400;
    throw error;
  }

  const filename = `${crypto.randomUUID()}.${extension}`;
  const filePath = path.join(PRODUCT_IMAGE_DIR, filename);
  fs.writeFileSync(filePath, buffer, { flag: "wx" });
  return { imagePath: `/product-images/${filename}`, filePath };
}

function removeProductImage(imagePath) {
  const match = /^\/product-images\/([a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.(?:jpg|png|webp))$/i.exec(imagePath || "");
  if (!match) return;
  const filePath = path.join(PRODUCT_IMAGE_DIR, match[1]);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function saveProductImages(files) {
  const savedImages = [];
  try {
    for (const file of files) {
      const image = saveProductImage(file);
      savedImages.push(image);
    }
    return savedImages;
  } catch (error) {
    for (const image of savedImages) {
      try {
        fs.unlinkSync(image.filePath);
      } catch (cleanupError) {
        console.error("Could not remove product image after a failed image upload:", cleanupError);
      }
    }
    throw error;
  }
}

function qrUrl(total, code) {
  if (!bankCode) return "";
  const query = new URLSearchParams({ amount: String(total), addInfo: code, accountName: bankAccountName });
  return `https://img.vietqr.io/image/${encodeURIComponent(bankCode)}-${encodeURIComponent(bankAccount)}-compact2.png?${query}`;
}

function cookieValue(request, name) {
  const prefix = `${name}=`;
  const cookie = (request.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

function csrf(request, response, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  const origin = request.get("origin");
  const fetchSite = request.get("sec-fetch-site");
  const token = cookieValue(request, "csrf");
  const suppliedToken = request.get("x-csrf-token") || "";
  const expectedOrigin = `${request.protocol}://${request.get("host")}`;
  if ((origin && origin !== expectedOrigin) || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") || !token || !safeEqual(token, suppliedToken)) {
    return response.status(403).json({ error: "Yêu cầu không hợp lệ. Hãy tải lại trang rồi thử lại." });
  }
  next();
}

function adminOnly(request, response, next) {
  const token = cookieValue(request, "admin_session");
  if (!token || token.length < 40) return response.status(401).json({ error: "Vui lòng đăng nhập quản trị." });
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const session = db.prepare("SELECT token_digest FROM admin_sessions WHERE token_digest = ? AND expires_at > ?").get(digest, toSqliteDate(new Date()));
  if (!session) {
    response.clearCookie("admin_session", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
    return response.status(401).json({ error: "Phiên đăng nhập đã hết hạn." });
  }
  next();
}

function customerOnly(request, response, next) {
  const token = cookieValue(request, "customer_session");
  if (!token || token.length < 40) return response.status(401).json({ error: "Vui lòng đăng nhập tài khoản khách." });
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const session = db.prepare(`
    SELECT customer_accounts.id, customer_accounts.username
    FROM customer_sessions
    JOIN customer_accounts ON customer_accounts.id = customer_sessions.customer_id
    WHERE customer_sessions.token_digest = ? AND customer_sessions.expires_at > ?
  `).get(digest, toSqliteDate(new Date()));
  if (!session) {
    response.clearCookie("customer_session", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
    return response.status(401).json({ error: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại." });
  }
  request.customer = session;
  next();
}

function createCustomerSession(response, customerId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = toSqliteDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
  db.prepare("DELETE FROM customer_sessions WHERE expires_at <= ?").run(toSqliteDate(new Date()));
  db.prepare("INSERT INTO customer_sessions (token_digest, customer_id, expires_at) VALUES (?, ?, ?)")
    .run(crypto.createHash("sha256").update(token).digest("hex"), customerId, expiresAt);
  response.cookie("customer_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function ensureCustomerWallet(customerId) {
  db.prepare("INSERT OR IGNORE INTO customer_wallets (customer_id, balance) VALUES (?, 0)").run(customerId);
}

function currentWheelConfiguration() {
  const configured = db.prepare(`
    SELECT wheel_prizes.product_id AS id, wheel_prizes.probability,
      products.name, products.ovr, products.description, products.image_path
    FROM wheel_prizes
    JOIN products ON products.id = wheel_prizes.product_id
    WHERE products.status = 'available'
    ORDER BY products.name COLLATE NOCASE, products.id
  `).all();
  const totalProbability = configured.reduce((sum, prize) => sum + prize.probability, 0);
  let assignedProbability = 0;
  const normalized = configured.map((prize, index) => {
    const probability = index === configured.length - 1
      ? WHEEL_PROBABILITY_TOTAL - assignedProbability
      : Math.floor(prize.probability * WHEEL_PROBABILITY_TOTAL / totalProbability);
    assignedProbability += probability;
    return { ...prize, probability };
  });
  const ready = normalized.length > 0 && totalProbability > 0;
  return {
    ready,
    prizes: ready ? attachProductImages(normalized).map((prize) => ({
      id: prize.id,
      name: prize.name,
      ovr: prize.ovr,
      description: prize.description,
      probability: prize.probability,
      images: prize.images
    })) : []
  };
}

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://img.vietqr.io"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));
app.use(express.json({ limit: "20kb", type: "application/json" }));
app.use("/api", (request, response, next) => {
  response.set("Cache-Control", "no-store");
  if (!cookieValue(request, "csrf")) {
    const token = crypto.randomBytes(32).toString("hex");
    response.cookie("csrf", token, { httpOnly: false, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
  }
  csrf(request, response, next);
});
app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Bạn thao tác quá nhanh. Vui lòng thử lại sau." }
}));
const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PRODUCT_IMAGE_SIZE, files: MAX_PRODUCT_IMAGES },
  fileFilter: (_request, file, callback) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      const error = new Error("Ảnh phải có định dạng JPG, PNG hoặc WebP.");
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau 15 phút." }
});
const customerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Quá nhiều lần thử tài khoản. Vui lòng thử lại sau 15 phút." }
});
const publicFiles = new Map([
  ["/", "shopxin.net.html"],
  ["/index.html", "shopxin.net.html"],
  ["/shopxin.net.html", "shopxin.net.html"],
  ["/style.css", "style.css"],
  ["/app.js", "app.js"],
  ["/admin.html", "admin.html"],
  ["/admin.js", "admin.js"]
]);
app.get([...publicFiles.keys()], (request, response, next) => {
  const file = publicFiles.get(request.path);
  response.sendFile(path.join(ROOT, file), (error) => {
    if (error) next(error);
  });
});
app.get("/product-images/:filename", (request, response, next) => {
  const filename = request.params.filename;
  if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.(?:jpg|png|webp)$/i.test(filename)) {
    return response.status(404).end();
  }
  const imageFile = path.join(PRODUCT_IMAGE_DIR, filename);
  if (!fs.existsSync(imageFile)) return response.status(404).end();
  response.set("Cache-Control", "public, max-age=31536000, immutable");
  response.set("X-Content-Type-Options", "nosniff");
  response.sendFile(imageFile, (error) => {
    if (error) next(error);
  });
});

app.get("/api/store", (_request, response) => {
  response.json({
    storeName: "OVR CLUB",
    bank: bankCode ? { code: bankCode, account: bankAccount, name: bankAccountName } : null,
    transferConfigured: Boolean(bankCode)
  });
});

app.get("/api/products", (_request, response) => {
  expireOrders();
  const products = db.prepare("SELECT id, name, ovr, price, description, image_path FROM products WHERE status = 'available' ORDER BY id DESC").all();
  response.json({ products: attachProductImages(products).map(safeProduct) });
});

app.get("/api/wheel", (_request, response) => {
  const wheel = currentWheelConfiguration();
  response.json({
    ready: wheel.ready,
    spinCost: WHEEL_SPIN_COST,
    topupPackages: WHEEL_TOPUP_PACKAGES,
    pointsPerVnd: 1 / 1000,
    prizes: wheel.prizes
  });
});

app.post("/api/customer/register", customerAuthLimiter, (request, response) => {
  const username = String(request.body?.username || "").trim().toLowerCase();
  const password = String(request.body?.password || "");
  if (!/^[a-z\d_.-]{3,32}$/.test(username)) {
    return response.status(400).json({ error: "Tên tài khoản cần dài 3–32 ký tự, chỉ dùng chữ không dấu, số, dấu chấm, gạch ngang hoặc gạch dưới." });
  }
  if (password.length < 12 || password.length > 256) {
    return response.status(400).json({ error: "Mật khẩu cần dài từ 12 đến 256 ký tự." });
  }

  const salt = crypto.randomBytes(16);
  const passwordHash = crypto.pbkdf2Sync(password, salt, customerPasswordIterations, 32, "sha256");
  const createCustomer = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO customer_accounts (username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?)
    `).run(username, passwordHash.toString("hex"), salt.toString("hex"), toSqliteDate(new Date()));
    ensureCustomerWallet(result.lastInsertRowid);
    return result;
  });
  let result;
  try {
    result = createCustomer();
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return response.status(409).json({ error: "Tên tài khoản này đã được sử dụng." });
    throw error;
  }

  createCustomerSession(response, result.lastInsertRowid);
  response.status(201).json({ authenticated: true, username });
});

app.post("/api/customer/login", customerAuthLimiter, (request, response) => {
  const username = String(request.body?.username || "").trim().toLowerCase();
  const password = String(request.body?.password || "");
  if (username.length > 32 || password.length > 256) return response.status(400).json({ error: "Tên tài khoản hoặc mật khẩu chưa đúng." });
  const customer = db.prepare("SELECT id, username, password_hash, password_salt FROM customer_accounts WHERE username = ?").get(username);
  const salt = customer ? Buffer.from(customer.password_salt, "hex") : Buffer.alloc(16);
  const candidate = crypto.pbkdf2Sync(password, salt, customerPasswordIterations, 32, "sha256");
  const expected = customer ? Buffer.from(customer.password_hash, "hex") : Buffer.alloc(32);
  if (!customer || !safeEqual(candidate, expected)) return response.status(401).json({ error: "Tên tài khoản hoặc mật khẩu chưa đúng." });
  createCustomerSession(response, customer.id);
  response.json({ authenticated: true, username: customer.username });
});

app.get("/api/customer/session", customerOnly, (request, response) => {
  response.json({ authenticated: true, username: request.customer.username });
});

app.post("/api/customer/logout", customerOnly, (request, response) => {
  const token = cookieValue(request, "customer_session");
  db.prepare("DELETE FROM customer_sessions WHERE token_digest = ?").run(crypto.createHash("sha256").update(token).digest("hex"));
  response.clearCookie("customer_session", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
  response.json({ ok: true });
});

app.get("/api/customer/orders", customerOnly, (request, response) => {
  expireOrders();
  const orders = db.prepare(`
    SELECT code, total, status, created_at, expires_at
    FROM orders
    WHERE customer_id = ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(request.customer.id);
  const codes = orders.map((order) => order.code);
  const allItems = codes.length
    ? db.prepare(`
        SELECT order_code, product_name AS name, ovr, login_cipher, password_cipher
        FROM order_items
        WHERE order_code IN (${codes.map(() => "?").join(",")})
        ORDER BY id
      `).all(...codes)
    : [];
  const itemsByOrder = new Map();
  for (const item of allItems) {
    const items = itemsByOrder.get(item.order_code) || [];
    items.push({
      name: item.name,
      ovr: item.ovr,
      ...(orders.find((order) => order.code === item.order_code)?.status === "paid"
        ? { username: decrypt(item.login_cipher), password: decrypt(item.password_cipher) }
        : {})
    });
    itemsByOrder.set(item.order_code, items);
  }
  response.json({
    orders: orders.map((order) => ({
      code: order.code,
      total: order.total,
      status: order.status,
      createdAt: order.created_at,
      expiresAt: order.expires_at,
      items: itemsByOrder.get(order.code) || []
    }))
  });
});

app.post("/api/customer/orders/claim", customerOnly, (request, response) => {
  const code = String(request.body?.code || "").trim().toUpperCase();
  const phone = normalizePhone(request.body?.phone);
  if (!/^FC\d{6}[A-F\d]{8}$/.test(code) || !phone) {
    return response.status(400).json({ error: "Mã đơn hoặc số điện thoại chưa đúng." });
  }
  const order = db.prepare("SELECT phone_digest, customer_id FROM orders WHERE code = ?").get(code);
  if (!order || !safeEqual(order.phone_digest, phoneDigest(phone))) {
    return response.status(404).json({ error: "Không tìm thấy đơn hàng phù hợp." });
  }
  if (order.customer_id === request.customer.id) return response.json({ claimed: true });
  if (order.customer_id !== null) return response.status(409).json({ error: "Đơn hàng này đã được liên kết với tài khoản khác." });
  const result = db.prepare("UPDATE orders SET customer_id = ? WHERE code = ? AND customer_id IS NULL")
    .run(request.customer.id, code);
  if (result.changes !== 1) return response.status(409).json({ error: "Không thể liên kết đơn hàng. Vui lòng tải lại lịch sử." });
  response.json({ claimed: true });
});

app.get("/api/customer/wallet", customerOnly, (request, response) => {
  ensureCustomerWallet(request.customer.id);
  const wallet = db.prepare("SELECT balance FROM customer_wallets WHERE customer_id = ?").get(request.customer.id);
  const topups = db.prepare(`
    SELECT code, amount, points, status, created_at AS createdAt
    FROM point_topups
    WHERE customer_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(request.customer.id);
  const spins = db.prepare(`
    SELECT id, product_name AS name, ovr, username_cipher, password_cipher,
      points_spent AS pointsSpent, created_at AS createdAt
    FROM wheel_spins
    WHERE customer_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(request.customer.id);
  response.json({
    balance: wallet.balance,
    topups,
    spins: spins.map((spin) => ({
      id: spin.id,
      name: spin.name,
      ovr: spin.ovr,
      pointsSpent: spin.pointsSpent,
      createdAt: spin.createdAt,
      username: decrypt(spin.username_cipher),
      password: decrypt(spin.password_cipher)
    }))
  });
});

app.post("/api/customer/wallet/topups", customerOnly, (request, response) => {
  if (!bankCode) return response.status(503).json({ error: "Cửa hàng chưa cấu hình tài khoản nhận chuyển khoản." });
  const amount = Number(request.body?.amount);
  if (!WHEEL_TOPUP_PACKAGES.includes(amount)) {
    return response.status(400).json({ error: "Vui lòng chọn một trong các gói nạp 10.000đ, 20.000đ, 50.000đ hoặc 100.000đ." });
  }
  const points = amount / 1000;
  const pendingTopup = db.prepare("SELECT code, amount FROM point_topups WHERE customer_id = ? AND status = 'pending'").get(request.customer.id);
  if (pendingTopup) {
    return response.json({
      existing: true,
      code: pendingTopup.code,
      amount: pendingTopup.amount,
      points: pendingTopup.amount / 1000,
      status: "pending",
      bank: { code: bankCode, account: bankAccount, name: bankAccountName, qrUrl: qrUrl(pendingTopup.amount, pendingTopup.code) }
    });
  }
  const code = `NAP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const createdAt = toSqliteDate(new Date());
  db.prepare(`
    INSERT INTO point_topups (code, customer_id, amount, points, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, request.customer.id, amount, points, createdAt);
  response.status(201).json({
    code,
    amount,
    points,
    status: "pending",
    createdAt,
    bank: { code: bankCode, account: bankAccount, name: bankAccountName, qrUrl: qrUrl(amount, code) }
  });
});

app.post("/api/customer/wheel/spin", customerOnly, (request, response) => {
  const wheel = currentWheelConfiguration();
  if (!wheel.ready) return response.status(503).json({ error: "Vòng quay chưa sẵn sàng. Quản trị viên cần cấu hình giải và tỷ lệ trúng." });
  const spin = db.transaction(() => {
    ensureCustomerWallet(request.customer.id);
    const wallet = db.prepare("SELECT balance FROM customer_wallets WHERE customer_id = ?").get(request.customer.id);
    if (wallet.balance < WHEEL_SPIN_COST) return { error: "not-enough-points", balance: wallet.balance };

    const draw = crypto.randomInt(WHEEL_PROBABILITY_TOTAL);
    let cumulative = 0;
    let selected = wheel.prizes.find((prize) => {
      cumulative += prize.probability;
      return draw < cumulative;
    });
    if (!selected) throw new Error("Vòng quay không có giải thưởng hợp lệ.");
    const product = db.prepare("SELECT * FROM products WHERE id = ? AND status = 'available'").get(selected.id);
    if (!product) return { error: "prize-unavailable" };

    const debit = db.prepare("UPDATE customer_wallets SET balance = balance - ? WHERE customer_id = ? AND balance >= ?")
      .run(WHEEL_SPIN_COST, request.customer.id, WHEEL_SPIN_COST);
    if (debit.changes !== 1) return { error: "not-enough-points" };
    const balance = db.prepare("SELECT balance FROM customer_wallets WHERE customer_id = ?").get(request.customer.id).balance;
    const createdAt = toSqliteDate(new Date());
    const spinResult = db.prepare(`
      INSERT INTO wheel_spins
        (customer_id, product_id, product_name, ovr, username_cipher, password_cipher, points_spent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(request.customer.id, product.id, product.name, product.ovr, product.login_cipher, product.password_cipher, WHEEL_SPIN_COST, createdAt);
    const sold = db.prepare("UPDATE products SET status = 'sold' WHERE id = ? AND status = 'available'").run(product.id);
    if (sold.changes !== 1) throw new Error("Giải thưởng vừa hết hàng; không thể hoàn tất lượt quay.");
    db.prepare(`
      INSERT INTO customer_point_transactions (customer_id, delta, balance_after, reason, reference, created_at)
      VALUES (?, ?, ?, 'spin', ?, ?)
    `).run(request.customer.id, -WHEEL_SPIN_COST, balance, String(spinResult.lastInsertRowid), createdAt);
    return {
      id: spinResult.lastInsertRowid,
      pointsSpent: WHEEL_SPIN_COST,
      balance,
      createdAt,
      prize: { id: product.id, name: product.name, ovr: product.ovr, username: decrypt(product.login_cipher), password: decrypt(product.password_cipher) }
    };
  });
  const result = spin();
  if (result.error === "not-enough-points") return response.status(400).json({ error: "Bạn chưa đủ điểm để quay. Hãy nạp thêm điểm.", balance: result.balance });
  if (result.error === "prize-unavailable") return response.status(409).json({ error: "Giải thưởng vừa hết hàng. Vui lòng tải lại vòng quay." });
  response.status(201).json(result);
});

app.post("/api/orders", customerOnly, (request, response) => {
  if (!bankCode) return response.status(503).json({ error: "Cửa hàng chưa cấu hình tài khoản nhận chuyển khoản." });
  const name = String(request.body?.name || "").trim();
  const phone = normalizePhone(request.body?.phone);
  const ids = request.body?.productIds;
  if (name.length < 2 || name.length > 80) return response.status(400).json({ error: "Tên người mua cần dài từ 2 đến 80 ký tự." });
  if (!phone) return response.status(400).json({ error: "Số điện thoại chưa đúng định dạng." });
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || ids.some((id) => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) {
    return response.status(400).json({ error: "Chọn từ 1 đến 5 tài khoản khác nhau." });
  }

  expireOrders();
  const code = orderCode();
  const now = new Date();
  const expiresAt = toSqliteDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const createOrder = db.transaction(() => {
    const placeholders = ids.map(() => "?").join(",");
    const products = db.prepare(`SELECT * FROM products WHERE id IN (${placeholders}) AND status = 'available'`).all(...ids);
    if (products.length !== ids.length) return null;
    const total = products.reduce((sum, product) => sum + product.price, 0);
    if (!Number.isSafeInteger(total) || total > 100000000) throw new Error("Giá trị đơn hàng vượt quá giới hạn.");
    db.prepare(`
      INSERT INTO orders (code, customer_id, customer_name_cipher, phone_cipher, phone_digest, total, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(code, request.customer.id, encrypt(name), encrypt(phone), phoneDigest(phone), total, toSqliteDate(now), expiresAt);
    const reserve = db.prepare("UPDATE products SET status = 'reserved' WHERE id = ? AND status = 'available'");
    const item = db.prepare("INSERT INTO order_items (order_code, product_id, product_name, ovr, login_cipher, password_cipher) VALUES (?, ?, ?, ?, ?, ?)");
    for (const product of products) {
      if (reserve.run(product.id).changes !== 1) throw new Error("Một tài khoản vừa được người khác đặt.");
      item.run(code, product.id, product.name, product.ovr, product.login_cipher, product.password_cipher);
    }
    return { total };
  });

  try {
    const order = createOrder();
    if (!order) return response.status(409).json({ error: "Một hoặc nhiều tài khoản vừa được đặt mất. Tải lại danh sách nhé." });
    response.status(201).json({
      code,
      total: order.total,
      status: "pending",
      expiresAt,
      bank: bankCode ? { code: bankCode, account: bankAccount, name: bankAccountName, qrUrl: qrUrl(order.total, code) } : null
    });
  } catch (error) {
    if (error.message === "Một tài khoản vừa được người khác đặt.") return response.status(409).json({ error: error.message });
    throw error;
  }
});

app.get("/api/orders/:code", (request, response) => {
  const code = String(request.params.code || "").trim().toUpperCase();
  const phone = normalizePhone(request.query.phone);
  if (!/^FC\d{6}[A-F\d]{8}$/.test(code) || !phone) return response.status(400).json({ error: "Mã đơn hoặc số điện thoại chưa đúng." });
  expireOrders();
  const order = db.prepare("SELECT code, phone_digest, total, status, created_at, expires_at FROM orders WHERE code = ?").get(code);
  if (!order || !safeEqual(order.phone_digest, phoneDigest(phone))) return response.status(404).json({ error: "Không tìm thấy đơn hàng phù hợp." });
  const items = db.prepare("SELECT product_name AS name, ovr, login_cipher, password_cipher FROM order_items WHERE order_code = ?").all(code);
  response.json({
    code: order.code,
    total: order.total,
    status: order.status,
    createdAt: order.created_at,
    expiresAt: order.expires_at,
    items: order.status === "paid" ? items.map((item) => ({ name: item.name, ovr: item.ovr, username: decrypt(item.login_cipher), password: decrypt(item.password_cipher) })) : items.map(({ name, ovr }) => ({ name, ovr }))
  });
});

app.post("/api/admin/login", loginLimiter, (request, response) => {
  const username = String(request.body?.username || "");
  const password = String(request.body?.password || "");
  if (username.length > 128 || password.length > 256) return response.status(400).json({ error: "Tên đăng nhập hoặc mật khẩu chưa đúng." });
  const candidate = crypto.pbkdf2Sync(password, adminPasswordSalt, 310000, 32, "sha256");
  if (!safeEqual(username, adminUsername) || !safeEqual(candidate, adminPasswordHash)) return response.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu chưa đúng." });
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = toSqliteDate(new Date(Date.now() + 8 * 60 * 60 * 1000));
  db.prepare("INSERT INTO admin_sessions (token_digest, expires_at) VALUES (?, ?)").run(crypto.createHash("sha256").update(token).digest("hex"), expiresAt);
  response.cookie("admin_session", token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 8 * 60 * 60 * 1000 });
  response.json({ authenticated: true, username: adminUsername });
});

app.get("/api/admin/session", adminOnly, (_request, response) => {
  response.json({ authenticated: true, username: adminUsername });
});

app.post("/api/admin/logout", adminOnly, (request, response) => {
  const token = cookieValue(request, "admin_session");
  db.prepare("DELETE FROM admin_sessions WHERE token_digest = ?").run(crypto.createHash("sha256").update(token).digest("hex"));
  response.clearCookie("admin_session", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
  response.json({ ok: true });
});

app.get("/api/admin/products", adminOnly, (_request, response) => {
  expireOrders();
  const products = db.prepare("SELECT id, name, ovr, price, description, status, created_at, image_path FROM products ORDER BY id DESC").all();
  response.json({
    products: attachProductImages(products).map(({ image_path, images, ...product }) => ({
      ...product,
      imagePath: images[0]?.image_path || image_path || null,
      images: images.map((image) => ({ id: image.id, imagePath: image.image_path }))
    }))
  });
});

app.post("/api/admin/products", adminOnly, productImageUpload.array("images", MAX_PRODUCT_IMAGES), (request, response) => {
  const name = String(request.body?.name || "").trim();
  const description = String(request.body?.description || "").trim();
  const username = String(request.body?.username || "").trim();
  const password = String(request.body?.password || "");
  const ovr = Number(request.body?.ovr);
  const price = Number(request.body?.price);
  if (name.length < 2 || name.length > 80) return response.status(400).json({ error: "Tên acc cần dài từ 2 đến 80 ký tự." });
  if (!Number.isInteger(ovr) || ovr < 1 || ovr > 200) return response.status(400).json({ error: "OVR cần là số nguyên từ 1 đến 200." });
  if (!Number.isSafeInteger(price) || price < 1000 || price > 100000000) return response.status(400).json({ error: "Giá cần nằm trong khoảng 1.000 đến 100.000.000 đồng." });
  if (!username || username.length > 200 || !password || password.length > 200) return response.status(400).json({ error: "Vui lòng nhập thông tin đăng nhập acc (tối đa 200 ký tự)." });
  if (description.length > 500) return response.status(400).json({ error: "Mô tả không được vượt quá 500 ký tự." });
  let images = [];
  try {
    images = saveProductImages(request.files || []);
    const insertProduct = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO products (name, ovr, price, description, login_cipher, password_cipher, status, created_at, image_path)
        VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)
      `).run(name, ovr, price, description, encrypt(username), encrypt(password), toSqliteDate(new Date()), images[0]?.imagePath || null);
      const insertImage = db.prepare("INSERT INTO product_images (product_id, image_path, position) VALUES (?, ?, ?)");
      images.forEach((image, position) => insertImage.run(result.lastInsertRowid, image.imagePath, position));
      return db.prepare("SELECT id, name, ovr, price, description, image_path FROM products WHERE id = ?").get(result.lastInsertRowid);
    });
    response.status(201).json({ product: safeProduct({ ...insertProduct(), images: images.map((image) => image.imagePath) }) });
  } catch (error) {
    for (const image of images) {
      try {
        if (fs.existsSync(image.filePath)) fs.unlinkSync(image.filePath);
      } catch (cleanupError) {
        console.error("Could not remove product image after a failed product save:", cleanupError);
      }
    }
    throw error;
  }
});

app.post("/api/admin/products/:id/images", adminOnly, productImageUpload.array("images", MAX_PRODUCT_IMAGES), (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Mã tài khoản không hợp lệ." });
  const files = request.files || [];
  if (files.length === 0) return response.status(400).json({ error: "Vui lòng chọn ít nhất một ảnh JPG, PNG hoặc WebP." });
  const product = db.prepare("SELECT id, image_path FROM products WHERE id = ?").get(id);
  if (!product) return response.status(404).json({ error: "Không tìm thấy tài khoản." });
  const existingImages = db.prepare("SELECT image_path FROM product_images WHERE product_id = ? ORDER BY position, id").all(id);
  const currentImagePaths = existingImages.length ? existingImages.map((image) => image.image_path) : (product.image_path ? [product.image_path] : []);
  if (currentImagePaths.length + files.length > MAX_PRODUCT_IMAGES) {
    return response.status(400).json({ error: `Mỗi acc tối đa ${MAX_PRODUCT_IMAGES} ảnh; acc này hiện có ${currentImagePaths.length} ảnh.` });
  }

  let images = [];
  try {
    images = saveProductImages(files);
    const addImages = db.transaction(() => {
      const insertImage = db.prepare("INSERT INTO product_images (product_id, image_path, position) VALUES (?, ?, ?)");
      images.forEach((image, index) => insertImage.run(id, image.imagePath, currentImagePaths.length + index));
      if (currentImagePaths.length === 0) db.prepare("UPDATE products SET image_path = ? WHERE id = ?").run(images[0].imagePath, id);
    });
    addImages();
  } catch (error) {
    for (const image of images) {
      try {
        if (fs.existsSync(image.filePath)) fs.unlinkSync(image.filePath);
      } catch (cleanupError) {
        console.error("Could not remove product image after a failed image update:", cleanupError);
      }
    }
    throw error;
  }

  response.json({ images: [...currentImagePaths, ...images.map((image) => image.imagePath)] });
});

app.delete("/api/admin/products/:id/images/:imageId", adminOnly, (request, response) => {
  const productId = Number(request.params.id);
  const imageId = Number(request.params.imageId);
  if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isSafeInteger(imageId) || imageId < 1) {
    return response.status(400).json({ error: "Mã tài khoản hoặc ảnh không hợp lệ." });
  }
  const image = db.prepare("SELECT id, product_id, image_path FROM product_images WHERE id = ? AND product_id = ?").get(imageId, productId);
  if (!image) return response.status(404).json({ error: "Không tìm thấy ảnh của tài khoản này." });

  const remainingImages = db.transaction(() => {
    db.prepare("DELETE FROM product_images WHERE id = ?").run(image.id);
    const remaining = db.prepare("SELECT id, image_path FROM product_images WHERE product_id = ? ORDER BY position, id").all(productId);
    const updatePosition = db.prepare("UPDATE product_images SET position = ? WHERE id = ?");
    remaining.forEach((item, position) => updatePosition.run(position, item.id));
    db.prepare("UPDATE products SET image_path = ? WHERE id = ?").run(remaining[0]?.image_path || null, productId);
    return remaining.map((item) => item.image_path);
  })();

  try {
    removeProductImage(image.image_path);
  } catch (error) {
    console.error("Could not remove product image after it was deleted from the gallery:", error);
  }
  response.json({ images: remainingImages });
});

app.delete("/api/admin/products/:id", adminOnly, (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Mã tài khoản không hợp lệ." });
  const result = db.prepare("UPDATE products SET status = 'archived' WHERE id = ? AND status = 'available'").run(id);
  if (result.changes === 0) {
    const product = db.prepare("SELECT status FROM products WHERE id = ?").get(id);
    if (!product) return response.status(404).json({ error: "Không tìm thấy tài khoản." });
    return response.status(409).json({ error: "Chỉ có thể xóa tài khoản còn hàng; hãy xử lý đơn đang giữ trước." });
  }
  response.json({ deleted: true });
});

app.get("/api/admin/wheel/prizes", adminOnly, (_request, response) => {
  const prizes = db.prepare(`
    SELECT wheel_prizes.product_id AS id, wheel_prizes.probability, products.name, products.ovr, products.status
    FROM wheel_prizes
    JOIN products ON products.id = wheel_prizes.product_id
    ORDER BY products.name COLLATE NOCASE, products.id
  `).all();
  const products = db.prepare(`
    SELECT id, name, ovr, status
    FROM products
    WHERE status = 'available'
    ORDER BY name COLLATE NOCASE, id
  `).all();
  response.json({
    spinCost: WHEEL_SPIN_COST,
    probabilityTotal: WHEEL_PROBABILITY_TOTAL,
    prizes,
    products
  });
});

app.put("/api/admin/wheel/prizes", adminOnly, (request, response) => {
  const prizes = request.body?.prizes;
  if (!Array.isArray(prizes) || prizes.length < 1 || prizes.length > 50) {
    return response.status(400).json({ error: "Chọn từ 1 đến 50 tài khoản làm giải thưởng." });
  }
  const normalized = [];
  const productIds = new Set();
  for (const prize of prizes) {
    const productId = Number(prize?.productId);
    const probability = Number(prize?.probability);
    const probabilityBps = Math.round(probability * 100);
    if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isFinite(probability)
      || Math.abs(probability * 100 - probabilityBps) > 1e-8
      || probabilityBps < 1 || probabilityBps > WHEEL_PROBABILITY_TOTAL) {
      return response.status(400).json({ error: "Mỗi giải cần có mã tài khoản hợp lệ và tỷ lệ từ 0,01% đến 100%." });
    }
    if (productIds.has(productId)) return response.status(400).json({ error: "Không thể chọn trùng một tài khoản làm nhiều giải." });
    productIds.add(productId);
    normalized.push({ productId, probability: probabilityBps });
  }
  if (normalized.reduce((sum, prize) => sum + prize.probability, 0) !== WHEEL_PROBABILITY_TOTAL) {
    return response.status(400).json({ error: "Tổng tỷ lệ trúng phải chính xác 100%." });
  }

  const savePrizes = db.transaction(() => {
    const placeholders = normalized.map(() => "?").join(",");
    const available = db.prepare(`SELECT id FROM products WHERE status = 'available' AND id IN (${placeholders})`)
      .all(...normalized.map((prize) => prize.productId));
    if (available.length !== normalized.length) return false;
    db.prepare("DELETE FROM wheel_prizes").run();
    const insert = db.prepare("INSERT INTO wheel_prizes (product_id, probability) VALUES (?, ?)");
    normalized.forEach((prize) => insert.run(prize.productId, prize.probability));
    return true;
  });
  if (!savePrizes()) return response.status(409).json({ error: "Một hoặc nhiều tài khoản không còn ở trạng thái còn hàng. Hãy tải lại kho giải." });
  response.json({ saved: true });
});

app.get("/api/admin/wheel/topups", adminOnly, (_request, response) => {
  const topups = db.prepare(`
    SELECT point_topups.id, point_topups.code, customer_accounts.username,
      point_topups.amount, point_topups.points, point_topups.status,
      point_topups.created_at AS createdAt, point_topups.reviewed_at AS reviewedAt
    FROM point_topups
    JOIN customer_accounts ON customer_accounts.id = point_topups.customer_id
    ORDER BY CASE point_topups.status WHEN 'pending' THEN 0 ELSE 1 END, point_topups.created_at DESC
    LIMIT 200
  `).all();
  response.json({ topups });
});

app.patch("/api/admin/wheel/topups/:id", adminOnly, (request, response) => {
  const id = Number(request.params.id);
  const action = request.body?.action;
  if (!Number.isSafeInteger(id) || id < 1 || !["approve", "reject"].includes(action)) {
    return response.status(400).json({ error: "Yêu cầu duyệt nạp điểm không hợp lệ." });
  }
  const result = db.transaction(() => {
    const topup = db.prepare("SELECT id, customer_id, points, status FROM point_topups WHERE id = ?").get(id);
    if (!topup) return "missing";
    if (topup.status !== "pending") return "not-pending";
    const reviewedAt = toSqliteDate(new Date());
    const status = action === "approve" ? "approved" : "rejected";
    db.prepare("UPDATE point_topups SET status = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, reviewedAt, id);
    if (action === "approve") {
      ensureCustomerWallet(topup.customer_id);
      db.prepare("UPDATE customer_wallets SET balance = balance + ? WHERE customer_id = ?").run(topup.points, topup.customer_id);
      const balance = db.prepare("SELECT balance FROM customer_wallets WHERE customer_id = ?").get(topup.customer_id).balance;
      db.prepare(`
        INSERT INTO customer_point_transactions (customer_id, delta, balance_after, reason, reference, created_at)
        VALUES (?, ?, ?, 'topup', ?, ?)
      `).run(topup.customer_id, topup.points, balance, String(topup.id), reviewedAt);
    }
    return status;
  })();
  if (result === "missing") return response.status(404).json({ error: "Không tìm thấy yêu cầu nạp điểm." });
  if (result === "not-pending") return response.status(409).json({ error: "Yêu cầu nạp điểm này đã được xử lý." });
  response.json({ status: result });
});

app.patch("/api/admin/orders/:code", adminOnly, (request, response) => {
  const code = String(request.params.code || "").toUpperCase();
  const action = request.body?.action;
  if (!/^FC\d{6}[A-F\d]{8}$/.test(code) || !["confirm", "cancel"].includes(action)) return response.status(400).json({ error: "Thao tác đơn hàng không hợp lệ." });
  expireOrders();
  const updateOrder = db.transaction(() => {
    const order = db.prepare("SELECT code, status FROM orders WHERE code = ?").get(code);
    if (!order) return "missing";
    if (order.status !== "pending") return "not-pending";
    const items = db.prepare("SELECT product_id FROM order_items WHERE order_code = ?").all(code);
    if (action === "confirm") {
      db.prepare("UPDATE orders SET status = 'paid' WHERE code = ? AND status = 'pending'").run(code);
      const sold = db.prepare("UPDATE products SET status = 'sold' WHERE id = ? AND status = 'reserved'");
      for (const item of items) {
        if (sold.run(item.product_id).changes !== 1) throw new Error("Không thể chốt đơn do trạng thái tồn kho đã thay đổi.");
      }
      return "paid";
    }
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE code = ? AND status = 'pending'").run(code);
    const release = db.prepare("UPDATE products SET status = 'available' WHERE id = ? AND status = 'reserved'");
    for (const item of items) release.run(item.product_id);
    return "cancelled";
  });
  const result = updateOrder();
  if (result === "missing") return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
  if (result === "not-pending") return response.status(409).json({ error: "Đơn không còn ở trạng thái chờ xác nhận." });
  response.json({ status: result });
});

app.get("/api/admin/orders", adminOnly, (_request, response) => {
  expireOrders();
  const orders = db.prepare("SELECT code, customer_name_cipher, phone_cipher, total, status, created_at, expires_at FROM orders ORDER BY created_at DESC LIMIT 200").all();
  const codes = orders.map((order) => order.code);
  const allItems = codes.length
    ? db.prepare(`SELECT order_code, product_name AS name, ovr FROM order_items WHERE order_code IN (${codes.map(() => "?").join(",")}) ORDER BY id`).all(...codes)
    : [];
  const itemsByOrder = new Map();
  for (const item of allItems) {
    const items = itemsByOrder.get(item.order_code) || [];
    items.push({ name: item.name, ovr: item.ovr });
    itemsByOrder.set(item.order_code, items);
  }
  response.json({
    orders: orders.map((order) => ({
      code: order.code,
      customerName: decrypt(order.customer_name_cipher),
      phone: decrypt(order.phone_cipher),
      total: order.total,
      status: order.status,
      createdAt: order.created_at,
      expiresAt: order.expires_at,
      items: itemsByOrder.get(order.code) || []
    }))
  });
});

app.use("/api", (_request, response) => response.status(404).json({ error: "Không tìm thấy chức năng yêu cầu." }));
app.use((error, request, response, _next) => {
  console.error(`[${new Date().toISOString()}] ${request.method} ${request.path}:`, error);
  if (response.headersSent) return;
  if (error.type === "entity.parse.failed") return response.status(400).json({ error: "Dữ liệu gửi lên không phải JSON hợp lệ." });
  if (error.type === "entity.too.large") return response.status(413).json({ error: "Dữ liệu gửi lên vượt quá giới hạn." });
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return response.status(413).json({ error: "Mỗi ảnh tải lên tối đa 5 MB." });
  if (error instanceof multer.MulterError && ["LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE"].includes(error.code)) return response.status(400).json({ error: `Mỗi acc được tải lên tối đa ${MAX_PRODUCT_IMAGES} ảnh.` });
  if (error.status === 400) return response.status(400).json({ error: error.message });
  response.status(500).json({ error: "Máy chủ gặp lỗi. Vui lòng thử lại hoặc liên hệ quản trị viên." });
});

app.listen(port, () => {
  console.log(`OVR CLUB đang chạy tại http://localhost:${port}`);
  console.log("Admin/API cấu hình từ .env. Không dùng HTTP công khai để xử lý dữ liệu thật; cần HTTPS khi triển khai.");
});

function shutdown() {
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
