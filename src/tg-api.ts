import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { getMimeType } from "./tg-utils";

// ── Telegram wire types ───────────────────────────────────────────────────────

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// ── Telegram API wrappers ─────────────────────────────────────────────────────

/**
 * Sends a plain-text message to a Telegram chat.
 * @param tgApi  Base URL: `https://api.telegram.org/bot<token>`
 * @param chatId Target chat or user ID
 * @param text   Message text
 */
export async function tgSendMessage(
  tgApi: string,
  chatId: string,
  text: string
): Promise<void> {
  const res = await fetch(`${tgApi}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`sendMessage failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Sends a photo file to a Telegram chat.
 * @param tgApi     Base URL
 * @param chatId    Target chat or user ID
 * @param imagePath Absolute path to the image file
 * @param caption   Caption text for the photo
 */
export async function tgSendPhoto(
  tgApi: string,
  chatId: string,
  imagePath: string,
  caption: string
): Promise<void> {
  const imageData = await readFile(imagePath);
  const ext = extname(imagePath).toLowerCase();
  const mimeType = getMimeType(ext);
  const blob = new Blob([imageData], { type: mimeType });
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("photo", blob, basename(imagePath));
  const res = await fetch(`${tgApi}/sendPhoto`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`sendPhoto failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Long-polls Telegram for new updates.
 * @param tgApi       Base URL
 * @param offset      Update offset (exclusive lower bound)
 * @param timeoutSecs Server-side long-poll timeout in seconds
 */
export async function tgGetUpdates(
  tgApi: string,
  offset: number,
  timeoutSecs: number
): Promise<TgUpdate[]> {
  const res = await fetch(`${tgApi}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offset, timeout: timeoutSecs, allowed_updates: ["message"] }),
    signal: AbortSignal.timeout((timeoutSecs + 5) * 1000),
  });
  if (!res.ok) {
    throw new Error(`getUpdates failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { ok: boolean; result: TgUpdate[] };
  return data.result ?? [];
}
