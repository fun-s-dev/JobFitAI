/**
 * Builds a small but structurally valid PDF in memory (no Chromium, no files).
 * Used to exercise the real pdf-parse extraction path with synthetic text.
 * Lines are paginated (45 per page) because text positioned outside a page is not extracted.
 *
 * @param {string[]} lines Text lines (empty array = one page with no text)
 * @returns {Buffer}
 */
export function makeTextPdf(lines = []) {
  const LINES_PER_PAGE = 45;
  const escapePdf = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }

  // Object layout: 1 catalog, 2 pages, 3 font, then (page, content) pairs
  const objects = [];
  const fontObjNumber = 3;
  const firstPageObjNumber = 4;
  const kids = pages.map((_, i) => `${firstPageObjNumber + i * 2} 0 R`).join(' ');

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  pages.forEach((pageLines, i) => {
    const contentObjNumber = firstPageObjNumber + i * 2 + 1;
    const textOps = pageLines.length
      ? `BT /F1 11 Tf 40 760 Td 15 TL ${pageLines.map((l) => `(${escapePdf(l)}) Tj T*`).join(' ')} ET`
      : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNumber} 0 R /Resources << /Font << /F1 ${fontObjNumber} 0 R >> >> >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(textOps)} >>\nstream\n${textOps}\nendstream`);
  });

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
