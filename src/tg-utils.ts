/** Maps file extension → MIME type for Telegram photo uploads. */
export const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Returns the MIME type for a given file extension.
 * Falls back to "image/jpeg" for unknown extensions.
 */
export function getMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? "image/jpeg";
}

/**
 * Builds the Telegram message text for a request.
 * Prepends the context block when provided.
 */
export function formatTelegramText(question: string, context?: string): string {
  if (context) return `[Context: ${context}]\n\n${question}`;
  return question;
}
