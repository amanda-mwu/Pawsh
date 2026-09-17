import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A PHOTO TILE OPENS THE PHOTO, FULL SIZE, IN THE PRODUCT'S OWN DIALOG.
 *
 * The strip drew 118px thumbnails and pressing one did nothing. Human QA asked for the obvious
 * thing: press the photo, see the photo, press X to come back. What this file holds:
 *
 *   THE TILE IS A BUTTON with an accessible name that says which photo it is, wrapping the same
 *       <img> - same URL, same alt - and the Remove control stays its own button beside it.
 *   THE PREVIEW IS A <dialog> in index.html, named by its caption, closed by the surface's own X.
 *   OPENING writes the tile's URL and alt into the preview, names it, and puts focus on the X;
 *       CLOSING empties the preview and hands focus back to the tile that opened it - or to that
 *       tile's replacement by photo id, when the strip was redrawn underneath.
 *
 * The browser walk (`tests/e2e/appointment-photo-lightbox.spec.ts`) presses the real tile over
 * a real upload; this file runs the real markup and the real open/close against a recorded
 * dialog, so the focus contract is asserted rather than described.
 */
const source = readFileSync("public/app.js", "utf8");
const html = readFileSync("public/index.html", "utf8");

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(from)}`);
  const end = source.indexOf(to, start);
  if (end < 0) throw new Error(`public/app.js no longer contains ${JSON.stringify(to)}`);
  return source.slice(start, end);
}

/** The photo URL, the tile, the lightbox open/setup, and the strip that draws the tiles. */
const PHOTOS = slice("function appointmentPhotoUrl(photo){", "\nasync function uploadAppointmentPhoto(");

interface FakeNode {
  focused: number;
  isConnected: boolean;
  dataset: Record<string, string>;
  focus(): void;
}

interface FakeDialog {
  open: boolean;
  dataset: Record<string, string>;
  caption: string;
  body: string;
  image: { listeners: Record<string, () => void>; hidden: boolean };
  error: { hidden: boolean };
  close: FakeNode;
  showModal(): void;
  closeDialog(): void;
  querySelector(selector: string): unknown;
  addEventListener(name: string, handler: () => void): void;
}

interface Module {
  photoTileMarkup(photo: Record<string, unknown>, canEdit: boolean, context?: { petName: string; label: string }): string;
  photoPhaseMarkup(pet: Record<string, unknown>, phase: string, label: string, canEdit: boolean, limit: number): string;
  appointmentPhotosMarkup(state: Record<string, unknown>): string;
  openPhotoLightbox(options: { src: string; alt: string; caption?: string; origin?: FakeNode | null }): void;
  setupPhotoLightbox(): void;
  dialog: FakeDialog;
  /** What `$('[data-photo-open="<id>"]')` answers with, for the redrawn-strip case. */
  replacements: Record<string, FakeNode>;
}

function node(): FakeNode {
  const self: FakeNode = { focused: 0, isConnected: true, dataset: {}, focus() { self.focused += 1; } };
  return self;
}

function load(): Module {
  const escape = (value = "") =>
    String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const escapeAttr = (value = "") =>
    escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const petName = (record: { petName?: string }) => record.petName || "Pet";

  const listeners: Record<string, Array<() => void>> = {};
  const dialog: FakeDialog = {
    open: false, dataset: {}, caption: "", body: "",
    image: { listeners: {}, hidden: false }, error: { hidden: true },
    close: node(),
    showModal() { dialog.open = true; },
    closeDialog() { dialog.open = false; for (const handler of listeners.close ?? []) handler(); },
    querySelector(selector: string) {
      if (selector.includes("photo-lightbox-caption")) return { set textContent(value: string) { dialog.caption = value; } };
      if (selector.includes("photo-lightbox-body")) {
        return {
          set innerHTML(value: string) { dialog.body = value; },
          querySelector(inner: string) {
            if (inner === "img") return { hidden: false, addEventListener(name: string, handler: () => void) { dialog.image.listeners[name] = handler; } };
            if (inner.includes("photo-lightbox-error")) return dialog.error;
            return null;
          }
        };
      }
      if (selector.includes("photo-lightbox-close")) {
        return { focus: () => dialog.close.focus(), addEventListener(name: string, handler: () => void) { if (name === "click") listeners.click = [handler]; } };
      }
      return null;
    },
    addEventListener(name: string, handler: () => void) { (listeners[name] ??= []).push(handler); }
  };
  const replacements: Record<string, FakeNode> = {};
  const $ = (selector: string): unknown => {
    if (selector === "#photo-lightbox") return dialog;
    const id = /\[data-photo-open="([^"]+)"\]/u.exec(selector)?.[1];
    return id ? replacements[id] ?? null : null;
  };
  const document = { activeElement: node() };
  const scope: Record<string, unknown> = { escape, escapeAttr, petName, $, document, encodeURIComponent };
  const names = Object.keys(scope);
  const factory = new Function(
    ...names,
    [PHOTOS, "return {photoTileMarkup, photoPhaseMarkup, appointmentPhotosMarkup, openPhotoLightbox, setupPhotoLightbox};"].join("\n")
  ) as (...args: unknown[]) => Omit<Module, "dialog" | "replacements">;
  return { ...factory(...names.map((name) => scope[name])), dialog, replacements };
}

const PHOTO = { id: "p-1", originalFilename: "charlie before.png", width: 640, height: 480 };

describe("the tile is a button that opens the photo", () => {
  it("wraps the image in a named button and keeps Remove as its own control beside it", () => {
    const markup = load().photoTileMarkup(PHOTO, true, { petName: "Charlie", label: "Before" });
    const open = /<button[^>]*class="photo-open"[^>]*>/u.exec(markup)?.[0];
    expect(open).toContain('data-photo-open="p-1"');
    expect(open).toContain('aria-label="View Before photo of Charlie full size"');
    expect(open).toContain('aria-haspopup="dialog"');
    // The same read the strip has always made, and the alt text the tile has always carried.
    expect(markup).toContain('<img src="/api/appointment-photos/p-1/content" alt="charlie before.png"');
    expect(markup).toMatch(/<button[^>]*class="photo-open"[^>]*>\s*<img[^>]*>\s*<\/button>/u);
    // Remove is a sibling of the open button, not inside it: two controls, two names.
    expect(markup).toMatch(/<\/button>\s*<button[^>]*class="photo-remove"[^>]*aria-label="Remove charlie before.png"/u);
    // Read-only strips still open the photo; they just cannot remove it.
    const readOnly = load().photoTileMarkup(PHOTO, false, { petName: "Charlie", label: "After" });
    expect(readOnly).toContain('class="photo-open"');
    expect(readOnly).not.toContain("photo-remove");
  });

  it("the strip hands each tile its pet and phase, so the name says which photo it is", () => {
    const pet = { petId: "pet-1", petName: "Charlie", before: [PHOTO], after: [{ ...PHOTO, id: "p-2" }] };
    const markup = load().appointmentPhotosMarkup({ data: { pets: [pet], canEdit: true, maxPerPhase: 6 }, failed: false });
    expect(markup).toContain('aria-label="View Before photo of Charlie full size"');
    expect(markup).toContain('aria-label="View After photo of Charlie full size"');
    expect(markup).toContain('data-photo-caption="Before photo of Charlie"');
  });

  it("is a <dialog> in index.html, named by its caption and closed by the surface's own X", () => {
    const dialog = /<dialog id="photo-lightbox"[^>]*>[\s\S]*?<\/dialog>/u.exec(html)?.[0] ?? "";
    expect(dialog).toContain('aria-labelledby="photo-lightbox-caption"');
    expect(dialog).toContain('id="photo-lightbox-caption"');
    expect(dialog).toContain('class="surface-close" data-testid="photo-lightbox-close" aria-label="Close photo"');
    expect(dialog).toContain('data-testid="photo-lightbox-body"');
    // The image is written on open and emptied on close; the static markup holds none.
    expect(dialog).not.toContain("<img");
    // Wired at start-up beside the other dialogs.
    expect(source).toMatch(/setupPhotoLightbox\(\);\nbootstrap\(\);/u);
  });
});

describe("opening and closing the preview", () => {
  it("writes the tile's URL, alt and caption into the dialog, opens it modal, and focuses the X", () => {
    const app = load();
    app.setupPhotoLightbox();
    const tile = node();
    tile.dataset.photoOpen = "p-1";
    app.openPhotoLightbox({ src: "/api/appointment-photos/p-1/content", alt: "charlie before.png", caption: "Before photo of Charlie", origin: tile });
    expect(app.dialog.open).toBe(true);
    expect(app.dialog.caption).toBe("Before photo of Charlie");
    expect(app.dialog.body).toContain('<img src="/api/appointment-photos/p-1/content" alt="charlie before.png" data-testid="photo-lightbox-image">');
    expect(app.dialog.body).toContain('data-testid="photo-lightbox-error" hidden');
    expect(app.dialog.close.focused).toBe(1);
    // A second press while it is open does not reopen or retarget it.
    app.openPhotoLightbox({ src: "/other", alt: "other", origin: node() });
    expect(app.dialog.body).toContain("/api/appointment-photos/p-1/content");
  });

  it("closing empties the preview and hands focus back to the tile that opened it", () => {
    const app = load();
    app.setupPhotoLightbox();
    const tile = node();
    tile.dataset.photoOpen = "p-1";
    app.openPhotoLightbox({ src: "/api/appointment-photos/p-1/content", alt: "charlie before.png", origin: tile });
    app.dialog.closeDialog();
    expect(app.dialog.body).toBe("");
    expect(tile.focused).toBe(1);
    expect(app.dialog.dataset.photoOrigin).toBeUndefined();
  });

  it("finds the tile's replacement by photo id when the strip was redrawn underneath", () => {
    const app = load();
    app.setupPhotoLightbox();
    const tile = node();
    tile.dataset.photoOpen = "p-1";
    app.openPhotoLightbox({ src: "/api/appointment-photos/p-1/content", alt: "charlie before.png", origin: tile });
    // An upload or a removal rerendered the strip: the original node is detached, a new one
    // stands where it did.
    tile.isConnected = false;
    const replacement = node();
    app.replacements["p-1"] = replacement;
    app.dialog.closeDialog();
    expect(tile.focused).toBe(0);
    expect(replacement.focused).toBe(1);
  });

  it("a photo that cannot be decoded says so in words", () => {
    const app = load();
    app.setupPhotoLightbox();
    app.openPhotoLightbox({ src: "/api/appointment-photos/p-1/content", alt: "charlie before.png", origin: node() });
    expect(app.dialog.error.hidden).toBe(true);
    app.dialog.image.listeners.error?.();
    expect(app.dialog.error.hidden).toBe(false);
  });
});
