import * as pdfjs from 'pdfjs-dist';

// Vite bundles the pdfjs worker as an asset URL. The `*?url` module type is
// declared in asset-modules.ts (a .ts, since .d.ts is gitignored repo-wide).
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Extract a PDF's text as readable lines. pdfjs hands back text runs in an
// arbitrary order, so we reconstruct rows by their y position and order each
// row left-to-right by x — mirroring what pdftotext does. This ordering is what
// makes a local model read boxed statement layouts reliably (verified 9/9 on
// real mortgage statements; the naive item order fails on ~1/3).
export async function extractPdfText(file: File): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  let out = '';

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    const rows = new Map<number, Array<{ x: number; s: string }>>();
    for (const item of content.items) {
      // TextItem has str + a 6-element transform; skip marked-content items.
      const textItem = item as { str?: string; transform?: number[] };
      if (typeof textItem.str !== 'string' || !textItem.transform || !textItem.str) {
        continue;
      }
      const y = Math.round(textItem.transform[5] / 3) * 3; // ~3pt row buckets
      const x = textItem.transform[4];
      const row = rows.get(y) ?? [];
      row.push({ x, s: textItem.str });
      rows.set(y, row);
    }

    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out +=
        (rows.get(y) ?? [])
          .sort((a, b) => a.x - b.x)
          .map(o => o.s)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim() + '\n';
    }
    out += '\n';
  }

  return out;
}
