import { randomBytes, timingSafeEqual } from "node:crypto";

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key.length > 0) out[key] = value;
  }
  return out;
}

function sameSecret(actual, expected) {
  const left = Buffer.from(String(actual ?? ""));
  const right = Buffer.from(String(expected ?? ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createAuth(options = {}) {
  const password = options.password || "coc-keeper";
  const tokens = new Set();

  const login = (req, res) => {
    if (!sameSecret(req.body?.password, password)) {
      return res.status(401).json({ ok: false, error: "访问口令错误" });
    }
    const token = randomBytes(32).toString("hex");
    tokens.add(token);
    res.setHeader(
      "set-cookie",
      `coc_access=${token}; HttpOnly; SameSite=Lax; Path=/`
    );
    return res.json({ ok: true });
  };

  const isAuthorized = (req) => {
    const token = parseCookies(req.headers.cookie).coc_access;
    return typeof token === "string" && tokens.has(token);
  };

  const requireAccess = (req, res, next) => {
    if (isAuthorized(req)) return next();
    if (req.path.startsWith("/coc-api")) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return res.redirect("/login.html");
  };

  return { login, requireAccess, isAuthorized };
}
