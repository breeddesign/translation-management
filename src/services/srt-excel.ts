import ExcelJS from "exceljs";

interface SrtEntry {
  index: number;
  startTime: string;
  endTime: string;
  text: string;
}

// ── Parse SRT ───────────────────────────────────────────────

function parseSrt(content: string): SrtEntry[] {
  const blocks = content.trim().split(/\n\n+/);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const index = parseInt(lines[0], 10);
    const [startTime, endTime] = lines[1].split(" --> ").map((t) => t.trim());
    const text = lines.slice(2).join("\n");
    return { index, startTime, endTime, text };
  });
}

// ── SRT → Excel ─────────────────────────────────────────────

export async function srtToExcel(srtContent: string): Promise<Buffer> {
  const entries = parseSrt(srtContent);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Proofread");

  // Header
  sheet.columns = [
    { header: "#", key: "index", width: 6 },
    { header: "Start", key: "startTime", width: 16 },
    { header: "End", key: "endTime", width: 16 },
    { header: "Translation", key: "text", width: 80 },
  ];

  // Style header
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE2E8F0" },
  };

  // Data
  for (const entry of entries) {
    sheet.addRow({
      index: entry.index,
      startTime: entry.startTime,
      endTime: entry.endTime,
      text: entry.text,
    });
  }

  // Wrap text in translation column
  sheet.getColumn("text").alignment = { wrapText: true, vertical: "top" };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ── Excel → SRT ─────────────────────────────────────────────

export async function excelToSrt(excelBuffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(excelBuffer as unknown as ExcelJS.Buffer);

  const sheet = workbook.getWorksheet("Proofread") ?? workbook.worksheets[0];
  if (!sheet) throw new Error("No worksheet found in Excel file");

  const lines: string[] = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header

    const index = row.getCell(1).value;
    const startTime = String(row.getCell(2).value ?? "").trim();
    const endTime = String(row.getCell(3).value ?? "").trim();
    const text = String(row.getCell(4).value ?? "").trim();

    if (!startTime || !endTime || !text) return;

    lines.push(`${index}`);
    lines.push(`${startTime} --> ${endTime}`);
    lines.push(text);
    lines.push(""); // blank line
  });

  return lines.join("\n");
}
