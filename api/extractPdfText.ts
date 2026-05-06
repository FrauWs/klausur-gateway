import pdfParse from "pdf-parse";

export const config = {
  runtime: "nodejs",
  maxDuration: 30,
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "METHOD_NOT_ALLOWED",
    });
  }

  try {
    const {
      imageBase64,
      imageMimeType,
      fileName,
    } = req.body ?? {};

    if (!imageBase64) {
      return res.status(400).json({
        ok: false,
        error: "NO_FILE",
      });
    }

    if (imageMimeType !== "application/pdf") {
      return res.status(400).json({
        ok: false,
        error: "INVALID_MIME_TYPE",
      });
    }

    const buffer = Buffer.from(imageBase64, "base64");

    const parsed = await pdfParse(buffer);

    const text = String(parsed.text ?? "")
      .replace(/\s+/g, " ")
      .trim();

    console.log("PDF_PARSE_RESULT", {
      fileName,
      textLength: text.length,
      preview: text.slice(0, 1000),
    });

    return res.status(200).json({
      ok: true,
      text,
      debug: {
        fileName,
        textLength: text.length,
      },
    });
  } catch (error: any) {
    console.error("PDF_PARSE_ERROR", error);

    return res.status(500).json({
      ok: false,
      error: error?.message ?? "PDF_PARSE_FAILED",
    });
  }
}
