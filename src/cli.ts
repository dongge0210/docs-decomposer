import { resolve } from "node:path";
import { processPdf } from "./pdf.js";
import { renderMarkdown } from "./processor.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run process -- <file.pdf>");
  process.exitCode = 1;
} else {
  try {
    const document = await processPdf(resolve(inputPath));
    process.stdout.write(renderMarkdown(document));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to process PDF: ${message}`);
    process.exitCode = 1;
  }
}