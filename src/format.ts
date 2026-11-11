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

/** `—` (no end), `today`, `tomorrow`, `in 6 days` (within two weeks), else `11 Dec`. */
export function expiryLabel(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const days = Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  return shortDate(iso, now);
}

/** Grant statuses as people read them: `active`, `applying` (being set up), `retrying` (failed, retried). */
export const statusLabel = (status: string) => (status === "active" ? "active" : status === "pending" ? "applying" : status === "error" ? "retrying" : status);
