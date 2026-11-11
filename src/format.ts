// How rows read in the terminal: engine names, levels, expiry ("11 Dec", "in 6 days"), status.
import type { DbAccessRow } from "./api";

export const engineLabel = (engine: string) => (engine === "clickhouse" ? "ClickHouse" : engine === "pg" ? "Postgres" : engine);

export const levelLabel = (row: Pick<DbAccessRow, "level" | "allowSchema">) => (row.level === "write" ? (row.allowSchema ? "write+schema" : "write") : "read");

export const placeLabel = (row: Pick<DbAccessRow, "environment" | "cluster">) =>
  row.environment ? `${row.environment.projectName} · ${row.environment.name}` : `${row.cluster.name} (not linked)`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `11 Dec` (with the year when not this year). */
export function shortDate(iso: string, now: Date): string {
  const d = new Date(iso);
  const s = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `12 Nov 2026, 17:52` in this machine's time zone. */
export function fullDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `in 1 day 2 h`, `in 45 min`, `3 h ago`, `2 days ago`: how far a moment is from now. */
export function relativeTime(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  const mins = Math.round(Math.abs(ms) / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const span =
    mins < 1 ? "" : days ? `${days} day${days === 1 ? "" : "s"}${days < 7 && hours ? ` ${hours} h` : ""}` : hours ? `${hours} h${mins % 60 && hours < 6 ? ` ${mins % 60} min` : ""}` : `${mins} min`;
  if (!span) return "now";
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

/** What the level lets the person do, in SQL words. */
export function levelMeaning(row: Pick<DbAccessRow, "level" | "allowSchema" | "cluster">): string {
  if (row.level === "read") return "SELECT only: no INSERT / UPDATE / DELETE, no schema changes";
  if (row.cluster.engine === "clickhouse") return "SELECT, INSERT, ALTER … UPDATE / DELETE, CREATE / DROP TABLE";
  return row.allowSchema ? "SELECT, INSERT, UPDATE, DELETE + schema changes (CREATE / ALTER / DROP)" : "SELECT, INSERT, UPDATE, DELETE: no schema changes";
}

/** `—` (no end), `in 23 h`, `in 1 day 2 h` (within two weeks), else `11 Dec`. */
export function expiryLabel(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return "now";
  if (ms < 14 * 86_400_000) return relativeTime(iso, now);
  return shortDate(iso, now);
}

/** Grant statuses as people read them: `active`, `applying` (being set up), `retrying` (failed, retried). */
export const statusLabel = (status: string) => (status === "active" ? "active" : status === "pending" ? "applying" : status === "error" ? "retrying" : status);
