// Generates a FAKE HSBC-style text-layer PDF statement for the demo and manual
// testing of the PDF import flow. All names/numbers are invented — this is the
// only statement that ships in the repo; real statements are PII and live only
// in the gitignored DATA_DIR/imports/. Run: npm run sample:pdf
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'sample-data', 'hsbc-fake.pdf');

// Each cell: [x, y, text]. Origin is bottom-left; we lay rows top-down.
const esc = (s) => s.replace(/([()\\])/g, '\\$1');
const cells = [];
let y = 800;
const row = (...pairs) => { for (const [x, t] of pairs) cells.push([x, y, t]); y -= 22; };

row([40, 'HSBC Bank (Singapore) Limited']);
row([40, 'Statement of Account']);
row([40, 'Statement period 01 Jul 2025 to 31 Jul 2025']);
y -= 8;
row([40, 'Date'], [110, 'Transaction details'], [360, 'Withdrawal'], [440, 'Deposit'], [510, 'Balance']);
row([40, '01 Jul'], [110, 'BALANCE B/F'], [510, '5,000.00']);
row([40, '02 Jul'], [110, 'POS PURCHASE NTUC FAIRPRICE'], [360, '85.20'], [510, '4,914.80']);
row([40, '05 Jul'], [110, 'GIRO SALARY ACME PTE LTD'], [440, '6,000.00'], [510, '10,914.80']);
row([40, '08 Jul'], [110, 'GRABPAY RIDE'], [360, '12.50'], [510, '10,902.30']);
row([40, '12 Jul'], [110, 'NETFLIX SUBSCRIPTION'], [360, '19.98'], [510, '10,882.32']);
row([40, '15 Jul'], [110, 'FAST TRANSFER TO'], [360, '300.00'], [510, '10,582.32']);
row([110, 'JANE TAN']); // continuation line — description spills over
row([40, '20 Jul'], [110, 'REFUND LAZADA'], [440, '40.00'], [510, '10,622.32']);
row([40, '31 Jul'], [110, 'BALANCE C/F'], [510, '10,622.32']);

const stream = 'BT /F1 9 Tf\n' +
  cells.map(([x, yy, t]) => `1 0 0 1 ${x} ${yy} Tm (${esc(t)}) Tj`).join('\n') +
  '\nET';

// Assemble a minimal one-page PDF.
const parts = [];
const obj = (n, body) => parts.push({ n, s: `${n} 0 obj\n${body}\nendobj\n` });
obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');
obj(4, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

let pdf = '%PDF-1.4\n';
const offsets = [];
for (const p of parts) { offsets.push(pdf.length); pdf += p.s; }
const xref = pdf.length;
pdf += `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
pdf += `trailer\n<< /Size ${parts.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(pdf, 'latin1'));
console.log(`wrote ${OUT} (${Buffer.byteLength(pdf)} bytes) — FAKE data, safe to commit`);
