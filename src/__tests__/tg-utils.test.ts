import { describe, test, expect } from "vitest";
import { getMimeType, formatTelegramText, MIME_MAP } from "../tg-utils";

// ── getMimeType ───────────────────────────────────────────────────────────────

describe("getMimeType", () => {
  test.each([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
  ])("returns correct MIME for %s", (ext, expected) => {
    expect(getMimeType(ext)).toBe(expected);
  });

  test("falls back to image/jpeg for unknown extension", () => {
    expect(getMimeType(".bmp")).toBe("image/jpeg");
    expect(getMimeType(".tiff")).toBe("image/jpeg");
    expect(getMimeType(".xyz")).toBe("image/jpeg");
  });

  test("falls back to image/jpeg for empty string", () => {
    expect(getMimeType("")).toBe("image/jpeg");
  });

  test("is case-insensitive (normalises to lowercase)", () => {
    expect(getMimeType(".JPG")).toBe("image/jpeg");
    expect(getMimeType(".PNG")).toBe("image/png");
    expect(getMimeType(".GIF")).toBe("image/gif");
    expect(getMimeType(".WEBP")).toBe("image/webp");
  });

  test("MIME_MAP contains exactly the expected keys", () => {
    expect(Object.keys(MIME_MAP).sort()).toEqual(
      [".gif", ".jpeg", ".jpg", ".png", ".webp"]
    );
  });
});

// ── formatTelegramText ────────────────────────────────────────────────────────

describe("formatTelegramText", () => {
  test("returns question unchanged when no context", () => {
    expect(formatTelegramText("What is the answer?")).toBe("What is the answer?");
  });

  test("prepends context block when context is provided", () => {
    const result = formatTelegramText("What is the answer?", "Some background");
    expect(result).toBe("[Context: Some background]\n\nWhat is the answer?");
  });

  test("handles empty question with context", () => {
    const result = formatTelegramText("", "ctx");
    expect(result).toBe("[Context: ctx]\n\n");
  });

  test("handles multi-line question", () => {
    const q = "Line one\nLine two";
    expect(formatTelegramText(q)).toBe(q);
  });

  test("handles multi-line context", () => {
    const result = formatTelegramText("Q?", "line1\nline2");
    expect(result).toBe("[Context: line1\nline2]\n\nQ?");
  });

  test("undefined context is treated the same as no context", () => {
    expect(formatTelegramText("Q?", undefined)).toBe("Q?");
  });

  test("empty-string context is falsy so treated as no context", () => {
    expect(formatTelegramText("Q?", "")).toBe("Q?");
  });
});
