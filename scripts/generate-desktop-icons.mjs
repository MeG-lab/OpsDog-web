import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const APP_ROOT = process.cwd();
const ICON_DIR = path.join(APP_ROOT, 'build/icons');
const SOURCE_SVG = path.join(ICON_DIR, 'opsdog.svg');
const ICO_PATH = path.join(ICON_DIR, 'opsdog.ico');
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

const createPng = async (sourceSvg, size) => {
  const image = await loadImage(Buffer.from(sourceSvg));
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  return canvas.toBuffer('image/png');
};

const createIco = (pngImages) => {
  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + pngImages.length * entrySize;
  const totalSize = directorySize + pngImages.reduce((sum, image) => sum + image.buffer.length, 0);
  const output = Buffer.alloc(totalSize);

  output.writeUInt16LE(0, 0);
  output.writeUInt16LE(1, 2);
  output.writeUInt16LE(pngImages.length, 4);

  let imageOffset = directorySize;
  pngImages.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize;
    output.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset);
    output.writeUInt8(image.size >= 256 ? 0 : image.size, entryOffset + 1);
    output.writeUInt8(0, entryOffset + 2);
    output.writeUInt8(0, entryOffset + 3);
    output.writeUInt16LE(1, entryOffset + 4);
    output.writeUInt16LE(32, entryOffset + 6);
    output.writeUInt32LE(image.buffer.length, entryOffset + 8);
    output.writeUInt32LE(imageOffset, entryOffset + 12);
    image.buffer.copy(output, imageOffset);
    imageOffset += image.buffer.length;
  });

  return output;
};

await mkdir(ICON_DIR, { recursive: true });
const sourceSvg = await readFile(SOURCE_SVG, 'utf8');
const pngImages = await Promise.all(ICON_SIZES.map(async (size) => ({
  size,
  buffer: await createPng(sourceSvg, size),
})));
await writeFile(ICO_PATH, createIco(pngImages));
process.stdout.write(`${ICO_PATH}\n`);

