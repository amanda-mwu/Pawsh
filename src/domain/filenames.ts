const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function safePdfFilename(value: string): { original: string; download: string } {
  const normalized = [...value.normalize("NFC")]
    .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      || character === "\\" || character === "/" ? " " : character)
    .join("").trim();
  const bounded = normalized.slice(0, 170).trim().replace(/[. ]+$/g, "");
  const base = bounded && !WINDOWS_RESERVED.test(bounded) ? bounded : "rabies-vaccination.pdf";
  const pdf = base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
  return { original: pdf, download: pdf.replace(/[";]/g, "_") };
}
