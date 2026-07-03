/**
 * Render an HTML document to a PDF. Returns the PDF bytes, or null on
 * platforms with no renderer (browser/API builds) — callers fall back to
 * attaching the HTML itself.
 */
export type RenderHtmlToPdf = (html: string) => Promise<Buffer | null>;
