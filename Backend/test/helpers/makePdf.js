/**
 * Builds a small but structurally valid PDF in memory (no Chromium, no files).
 * Used to exercise the real pdf-parse extraction path with synthetic text.
 * Lines are paginated (45 per page) because text positioned outside a page is not extracted.
 *
 * A line is a string, or an array of segments (`'plain text'` or `{ text, url }`). A segment with a url
 * becomes a clickable link annotation over that text, like a "LinkedIn" label in a real resume.
 *
 * @param {Array<string | Array<string | {text: string, url?: string}>>} lines (empty array = one page with no text)
 * @returns {Buffer}
 */
export function makeTextPdf(lines = []) {
  const LINES_PER_PAGE = 45;
  const FONT_SIZE = 11;
  const LEADING = 15;
  const CHAR_WIDTH = 6.1; // generous average advance of Helvetica 11pt, so link rectangles cover their text
  const escapePdf = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }

  // Object layout: 1 catalog, 2 pages, 3 font, then (page, content) pairs, then link annotations
  const fontObjNumber = 3;
  const firstPageObjNumber = 4;
  const firstAnnotObjNumber = firstPageObjNumber + pages.length * 2;
  const annotBodies = [];
  const pageAnnots = pages.map(() => []);

  const contents = pages.map((pageLines, pageIndex) => {
    const ops = [];
    pageLines.forEach((line, row) => {
      const y = 760 - row * LEADING;
      const segments = Array.isArray(line) ? line : [line];
      let x = 40;
      for (const segment of segments) {
        const text = typeof segment === 'string' ? segment : segment.text;
        if (!text) continue;
        ops.push(`BT /F1 ${FONT_SIZE} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdf(text)}) Tj ET`);
        const width = text.length * CHAR_WIDTH;
        if (typeof segment === 'object' && segment.url) {
          const objNumber = firstAnnotObjNumber + annotBodies.length;
          annotBodies.push(
            `<< /Type /Annot /Subtype /Link /Rect [${x} ${y - 3} ${(x + width).toFixed(1)} ${y + FONT_SIZE}] /Border [0 0 0] /A << /S /URI /URI (${escapePdf(segment.url)}) >> >>`
          );
          pageAnnots[pageIndex].push(objNumber);
        }
        x += width;
      }
    });
    return ops.join('\n');
  });

  const objects = [];
  const kids = pages.map((_, i) => `${firstPageObjNumber + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((_, i) => {
    const contentObjNumber = firstPageObjNumber + i * 2 + 1;
    const annots = pageAnnots[i].length ? ` /Annots [${pageAnnots[i].map((n) => `${n} 0 R`).join(' ')}]` : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNumber} 0 R${annots} /Resources << /Font << /F1 ${fontObjNumber} 0 R >> >> >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(contents[i])} >>\nstream\n${contents[i]}\nendstream`);
  });
  annotBodies.forEach((body) => objects.push(body));

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
