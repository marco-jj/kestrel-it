import PDFDocument from 'pdfkit';
import { PNG } from 'pngjs';
import { fieldIssue } from './custom-fields-validation.service.js';

const prefix = 'data:image/png;base64,';
const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function signaturePng(dataUrl: string): Buffer {
  if (!dataUrl.startsWith(prefix)) fieldIssue('signature', 'The signature must be a PNG');
  const body = dataUrl.slice(prefix.length);
  const bytes = Buffer.from(body, 'base64');
  if (
    bytes.length < 33 ||
    bytes.toString('base64') !== body ||
    !bytes.subarray(0, 8).equals(header) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    fieldIssue('signature', 'The signature PNG is invalid');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 2_048 || height > 2_048)
    fieldIssue('signature', 'The signature dimensions are invalid');
  let image: PNG;
  try {
    image = PNG.sync.read(bytes);
  } catch {
    fieldIssue('signature', 'The signature PNG is invalid');
  }
  let signed = false;
  for (let index = 0; index < image.data.length; index += 4) {
    if (
      image.data[index + 3]! > 0 &&
      (image.data[index]! < 240 || image.data[index + 1]! < 240 || image.data[index + 2]! < 240)
    ) {
      signed = true;
      break;
    }
  }
  if (!signed) fieldIssue('signature', 'Sign the form before submitting it');
  return PNG.sync.write(image);
}

export function acceptancePdf(data: {
  tag: string;
  name: string;
  model: string;
  serial: string;
  assignee: string;
  acceptedAt: Date;
  eula: string | null;
  note: string | null;
  signature: Buffer | null;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4',
      margin: 52,
      info: { Title: 'Asset checkout acceptance', Author: 'Kestrel-IT' },
    });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.once('error', reject);
    document.once('end', () => resolve(Buffer.concat(chunks)));
    document.fontSize(21).text('Asset checkout acceptance').moveDown();
    document
      .fontSize(11)
      .text(
        [
          `Asset tag: ${data.tag}`,
          `Asset: ${data.name}`,
          `Model: ${data.model}`,
          `Serial: ${data.serial}`,
          `Assignee: ${data.assignee}`,
          `Accepted at: ${data.acceptedAt.toISOString()}`,
        ].join('\n'),
      )
      .moveDown();
    if (data.eula) {
      document.fontSize(14).text('End-user license agreement').moveDown(0.35);
      document.fontSize(11).text(data.eula, { lineGap: 3 }).moveDown();
    }
    if (data.note) document.text(`Note: ${data.note}`).moveDown();
    if (data.signature) {
      if (document.y > 650) document.addPage();
      document.text('Signature').moveDown(0.25);
      document.image(data.signature, { fit: [300, 100] });
    }
    document.end();
  });
}
