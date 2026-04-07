import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const dbPath = process.env.DB_PATH || "./data/mvp.db";
const absPath = path.resolve(process.cwd(), dbPath);
fs.mkdirSync(path.dirname(absPath), { recursive: true });

const db = new Database(absPath);

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, user_id, channel)
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

const now = () => new Date().toISOString();

export function getSession(tenantId, userId, channel) {
  const stmt = db.prepare(
    "SELECT session_id FROM sessions WHERE tenant_id = ? AND user_id = ? AND channel = ?"
  );
  const row = stmt.get(tenantId, userId, channel);
  return row?.session_id ?? null;
}

export function upsertSession(tenantId, userId, channel, sessionId) {
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO sessions (tenant_id, user_id, channel, session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, channel)
    DO UPDATE SET
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `);
  stmt.run(tenantId, userId, channel, sessionId, ts, ts);
  return sessionId;
}

export function saveMessage({
  tenantId,
  userId,
  channel,
  sessionId,
  direction,
  content,
}) {
  const stmt = db.prepare(`
    INSERT INTO messages (tenant_id, user_id, channel, session_id, direction, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(tenantId, userId, channel, sessionId, direction, content, now());
}

export function listMessages({
  tenantId,
  userId,
  channel,
  sessionId = "",
  limit = 100,
}) {
  const clauses = ["tenant_id = ?", "user_id = ?", "channel = ?"];
  const params = [tenantId, userId, channel];

  if (sessionId) {
    clauses.push("session_id = ?");
    params.push(sessionId);
  }

  const sql = `
    SELECT id, session_id, direction, content, created_at
    FROM messages
    WHERE ${clauses.join(" AND ")}
    ORDER BY id DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  rows.reverse();
  return rows;
}

export function listSessions({
  tenantId = "",
  userId = "",
  channel = "",
  limit = 50,
}) {
  const clauses = [];
  const params = [];

  if (tenantId) {
    clauses.push("tenant_id = ?");
    params.push(tenantId);
  }
  if (userId) {
    clauses.push("user_id = ?");
    params.push(userId);
  }
  if (channel) {
    clauses.push("channel = ?");
    params.push(channel);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT tenant_id, user_id, channel, session_id, created_at, updated_at
    FROM sessions
    ${where}
    ORDER BY updated_at DESC
    LIMIT ?
  `;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function hasSessionMessages({
  tenantId,
  userId,
  channel,
  sessionId,
}) {
  const row = db
    .prepare(
      `
      SELECT 1
      FROM messages
      WHERE tenant_id = ?
        AND user_id = ?
        AND channel = ?
        AND session_id = ?
      LIMIT 1
    `
    )
    .get(tenantId, userId, channel, sessionId);
  return Boolean(row);
}

export function listUserChatSessions({
  tenantId,
  userId,
  channel,
  limit = 20,
}) {
  const rows = db
    .prepare(
      `
      WITH session_stats AS (
        SELECT
          session_id,
          MAX(id) AS last_id,
          COUNT(*) AS message_count,
          MAX(created_at) AS updated_at
        FROM messages
        WHERE tenant_id = ?
          AND user_id = ?
          AND channel = ?
        GROUP BY session_id
      )
      SELECT
        s.session_id,
        s.message_count,
        s.updated_at,
        m.direction AS last_role,
        m.content AS last_text,
        m.created_at AS last_created_at
      FROM session_stats s
      JOIN messages m ON m.id = s.last_id
      ORDER BY s.last_id DESC
      LIMIT ?
    `
    )
    .all(tenantId, userId, channel, limit);

  return rows;
}
