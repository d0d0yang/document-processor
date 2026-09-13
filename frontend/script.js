// point pdf.js at its worker. the global name changed across versions
// so check both
const pdfjsLib = window.pdfjsLib || window["pdfjs-dist/build/pdf"];
if (pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";
}

// only set if the server has APP_ACCESS_KEY configured (see backend/.env)
// for an actual gate put auth in front of the server itself.
const APP_ACCESS_KEY = "";

const form = document.getElementById("scan-form");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const dropzoneText = document.getElementById("dropzone-text");
const dropzoneFilename = document.getElementById("dropzone-filename");

const keywordsInput = document.getElementById("keywords-input");
const biasSlider = document.getElementById("bias-slider");
const dialReadout = document.getElementById("dial-readout");
const dialNote = document.getElementById("dial-note");

const submitBtn = document.getElementById("submit-btn");
const statusLine = document.getElementById("status-line");
const resultsSection = document.getElementById("results-section");
const ledgerMode = document.getElementById("ledger-mode");
const ledgerBody = document.getElementById("ledger-body");

let lastResult = null;

// file picking / drag and drop

dropzone.addEventListener("click", () => fileInput.click());

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dropzone--active");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dropzone--active");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dropzone--active");
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    updateFilenameDisplay();
  }
});

fileInput.addEventListener("change", updateFilenameDisplay);

function updateFilenameDisplay() {
  if (fileInput.files.length) {
    dropzoneText.hidden = true;
    dropzoneFilename.hidden = false;
    dropzoneFilename.textContent = fileInput.files[0].name;
  } else {
    dropzoneText.hidden = false;
    dropzoneFilename.hidden = true;
  }
}

// bias dial. locks to complete AI when there are no keywords to search for

function refreshDialState() {
  const hasKeywords = keywordsInput.value.trim().length > 0;

  if (!hasKeywords) {
    biasSlider.disabled = true;
    biasSlider.value = 100;
    dialReadout.textContent = "Complete AI";
    dialNote.textContent = "No keywords provided. Automatically processed by AI.";
    return;
  }

  biasSlider.disabled = false;
  updateDialReadout();
}

function updateDialReadout() {
  const value = Number(biasSlider.value);

  if (value === 0) {
    dialReadout.textContent = "Complete Manual";
    dialNote.textContent = "Entirely manual scan. Keywords must be present within document.";
  } else if (value === 100) {
    dialReadout.textContent = "Complete AI";
    dialNote.textContent = "Entirely AI scan.";
  } else {
    dialReadout.textContent = `${value}% AI / ${100 - value}% Manual`;
    dialNote.textContent = "Manual scan is weighed against AI scan.";
  }
}

keywordsInput.addEventListener("input", refreshDialState);
biasSlider.addEventListener("input", updateDialReadout);
refreshDialState();

// submit. complete manual with keywords stays entirely client side (pdf.js +
// tesseract.js). anything else needs the Flask server.

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!fileInput.files.length) {
    showStatus("Pick a document first.", true);
    return;
  }

  const file = fileInput.files[0];
  const rawKeywords = keywordsInput.value.trim();
  const keywordList = rawKeywords ? rawKeywords.split(",").map((k) => k.trim()).filter(Boolean) : [];
  const biasValue = Number(biasSlider.value) / 100;

  submitBtn.disabled = true;
  submitBtn.textContent = "Scanning...";
  resultsSection.hidden = true;

  try {
    if (keywordList.length && biasValue === 0) {
      await runPureOcrLocally(file, keywordList);
    } else {
      await runViaServer(file, rawKeywords, biasValue);
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Scan document";
  }
});

async function runPureOcrLocally(file, keywordList) {
  showStatus("Reading document...", false);

  if (!pdfjsLib || typeof Tesseract === "undefined") {
    showStatus("The OCR libraries didn't load, so this can't run offline right now. Check your connection and try again.", true);
    return;
  }

  try {
    const tokens = await getTokensClientSide(file, (msg) => showStatus(msg, false));
    const ocrResults = findKeywordMatches(tokens, keywordList);
    const formatted = formatOcrOnly(keywordList, ocrResults);
    renderResults({ mode: "pure_ocr", bias_used: 0, result: formatted });
    statusLine.hidden = true;
  } catch (err) {
    console.error(err);
    showStatus("Local OCR ran into a problem reading that file. Try a different browser, or move the slider off complete manual to run it through the server.", true);
  }
}

async function runViaServer(file, rawKeywords, biasValue) {
  // opened straight from disk rather than served by Flask relative
  // fetch has nowhere to go
  if (window.location.protocol === "file:") {
    showStatus(
      "This mode calls Gemini through the backend server, so it needs to be running. Start it with `python backend/app.py` and open this page at http://localhost:5000 instead of the file directly. Or set the slider to complete manual to run offline.",
      true
    );
    return;
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("keywords", rawKeywords);
  formData.append("prompt", document.getElementById("prompt-input").value.trim());
  formData.append("bias", biasValue.toFixed(2));

  showStatus("Reading document...", false);

  try {
    const response = await fetch("/scan", {
      method: "POST",
      headers: APP_ACCESS_KEY ? { "X-Access-Key": APP_ACCESS_KEY } : {},
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      showStatus(data.error || "Something went wrong.", true);
      return;
    }

    renderResults(data);
    statusLine.hidden = true;
  } catch (err) {
    showStatus("Couldn't reach the backend server. Make sure it's running at the address you're viewing this page from.", true);
  }
}

// pulling word tokens out of a document. every recognized word gets its own
// box instead of flattening the page into one string

const OCR_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "tiff", "bmp", "gif"]);
const OCR_TEXT_EXTENSIONS = new Set(["txt", "md"]);

async function getTokensClientSide(file, reportStatus) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();

  if (ext === "pdf") return getPdfTokens(file, reportStatus);
  if (OCR_IMAGE_EXTENSIONS.has(ext)) {
    reportStatus("Running OCR on the image...");
    return ocrImageTokens(file, 0);
  }
  if (OCR_TEXT_EXTENSIONS.has(ext)) return plaintextTokens(await file.text());

  try {
    return plaintextTokens(await file.text());
  } catch (err) {
    return [];
  }
}

async function getPdfTokens(file, reportStatus) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  let allTokens = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    reportStatus(`Reading page ${pageNum} of ${pdf.numPages}...`);
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    let pageTokens = [];
    for (const item of content.items) {
      pageTokens = pageTokens.concat(pdfItemToWordTokens(item, pageNum - 1));
    }

    // if a page barely has any text it's probably a scan with no text layer
    if (pageTokens.length < 5) {
      reportStatus(`Page ${pageNum} looks scanned, running OCR...`);
      pageTokens = await ocrRenderedPdfPageTokens(page, pageNum - 1);
    }

    allTokens = allTokens.concat(pageTokens);
  }
  return allTokens;
}

// pdf.js sends runs of text split on whitespace and spread each word 
// across the run's width proportionally. good enough for left to right, 
// same line or not layout checks.
function pdfItemToWordTokens(item, page) {
  const str = item.str;
  if (!str || !str.trim()) return [];

  const perCharWidth = item.width / Math.max(str.length, 1);
  const x0Base = item.transform[4];
  // pdf.js has y increasing upward from the bottom of the page. Flip it
  // so it matches the downward pixel coords used everywhere else.
  const y0 = -item.transform[5];
  const height = item.height || 10;

  const tokens = [];
  const wordRegex = /\S+/g;
  let match;
  while ((match = wordRegex.exec(str)) !== null) {
    const word = match[0];
    const start = match.index;
    const end = start + word.length;
    tokens.push({
      text: word,
      x0: x0Base + start * perCharWidth,
      x1: x0Base + end * perCharWidth,
      y0,
      y1: y0 + height,
      page,
    });
  }
  return tokens;
}

async function ocrRenderedPdfPageTokens(page, pageIndex) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return ocrImageTokens(canvas, pageIndex);
}

async function ocrImageTokens(imageSource, page) {
  const { data } = await Tesseract.recognize(imageSource, "eng");
  const words = data.words || [];
  return words.map((w) => ({
    text: w.text,
    x0: w.bbox.x0,
    y0: w.bbox.y0,
    x1: w.bbox.x1,
    y1: w.bbox.y1,
    page,
  }));
}

function plaintextTokens(text) {
  const tokens = [];
  text.split("\n").forEach((line, lineIndex) => {
    let cursor = 0;
    for (const word of line.split(/\s+/).filter(Boolean)) {
      const start = line.indexOf(word, cursor);
      const end = start + word.length;
      tokens.push({ text: word, x0: start, y0: lineIndex, x1: end, y1: lineIndex + 0.9, page: 0 });
      cursor = end;
    }
  });
  return tokens;
}

// matching. find the token span that best matches a keyword, then look at
// what's actually next to it. First right on the same line, then the line
// below. mirrors backend/ocr_engine.py so results look the same.

const LINE_MATCH_THRESHOLD = 60;
const CONTEXT_WINDOW = 6;
const LINE_OVERLAP_RATIO = 0.4;
// multiple of the label's own char width, not height, so it
// means the same in PDF points/OCR pixels/char offsets
const MAX_SAME_LINE_GAP_CHARS = 40;

function findKeywordMatches(tokens, keywords) {
  if (!keywords.length) return {};
  if (!tokens.length) {
    const empty = {};
    keywords.forEach((k) => (empty[k] = { value: null, confidence: 0, context: null }));
    return empty;
  }

  const readingOrder = tokens.slice().sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (a.y0 !== b.y0) return a.y0 - b.y0;
    return a.x0 - b.x0;
  });

  const results = {};
  for (const keyword of keywords) {
    results[keyword] = bestMatchForKeyword(keyword, readingOrder);
  }
  return results;
}

function bestMatchForKeyword(keyword, tokens) {
  const keywordWords = keyword.trim().split(/\s+/);
  const windowSizes = new Set([keywordWords.length, keywordWords.length + 1]);

  let bestSpan = null;
  let bestScore = 0;

  windowSizes.forEach((size) => {
    if (size <= 0) return;
    for (let i = 0; i <= tokens.length - size; i++) {
      const window = tokens.slice(i, i + size);
      if (window[0].page !== window[window.length - 1].page) continue;
      const candidate = window.map((t) => t.text).join(" ");
      const score = similarityRatio(keyword.toLowerCase(), candidate.toLowerCase());
      if (score > bestScore) {
        bestScore = score;
        bestSpan = window;
      }
    }
  });

  if (bestScore < LINE_MATCH_THRESHOLD || !bestSpan) {
    return { value: null, confidence: Math.round(bestScore), context: null };
  }

  const labelBox = unionBox(bestSpan);
  const valueTokens = findValueTokens(tokens, bestSpan, labelBox);

  if (!valueTokens.length) {
    return { value: null, confidence: Math.round(bestScore), context: spanText(bestSpan) };
  }

  const valueText = spanText(valueTokens);
  return {
    value: valueText,
    confidence: Math.round(bestScore),
    context: `${spanText(bestSpan)} -> ${valueText}`,
  };
}

function findValueTokens(tokens, labelSpan, labelBox) {
  const excluded = new Set(labelSpan);
  const maxGap = MAX_SAME_LINE_GAP_CHARS * typicalCharWidth(labelSpan, labelBox);

  const sameLineCandidates = tokens.filter(
    (t) =>
      !excluded.has(t) &&
      t.page === labelBox.page &&
      t.x0 >= labelBox.x1 - 1 &&
      sameLine(t, labelBox) &&
      t.x0 - labelBox.x1 < maxGap
  );
  if (sameLineCandidates.length) {
    sameLineCandidates.sort((a, b) => a.x0 - b.x0);
    return sameLineCandidates.slice(0, CONTEXT_WINDOW);
  }

  // val glued onto the label's own last word
  const lastWord = labelSpan[labelSpan.length - 1].text;
  for (const sep of [":", "-"]) {
    if (lastWord.includes(sep)) {
      const trailing = lastWord.split(sep).pop().trim();
      if (trailing) {
        return [{ text: trailing, x0: labelBox.x1, y0: labelBox.y0, x1: labelBox.x1, y1: labelBox.y1, page: labelBox.page }];
      }
    }
  }

  // nothing beside, try the underneath
  const labelHeight = labelBox.y1 - labelBox.y0 || 1;
  const below = tokens
    .filter((t) => !excluded.has(t) && t.page === labelBox.page && t.y0 >= labelBox.y1 - labelHeight * 0.2)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  if (!below.length) return [];

  const firstLineBand = { y0: below[0].y0, y1: below[0].y1 };
  return below.filter((t) => sameLine(t, firstLineBand)).slice(0, CONTEXT_WINDOW);
}

function typicalCharWidth(labelSpan, labelBox) {
  const totalChars = labelSpan.reduce((sum, t) => sum + t.text.length, 0) || 1;
  const width = labelBox.x1 - labelBox.x0 || totalChars;
  const charWidth = width / totalChars;
  return charWidth > 0 ? charWidth : 1;
}

function sameLine(token, band) {
  const tokenHeight = token.y1 - token.y0 || 1;
  const bandHeight = band.y1 - band.y0 || tokenHeight;
  const overlap = Math.min(token.y1, band.y1) - Math.max(token.y0, band.y0);
  return overlap > LINE_OVERLAP_RATIO * Math.min(tokenHeight, bandHeight);
}

function unionBox(span) {
  return {
    x0: Math.min(...span.map((t) => t.x0)),
    y0: Math.min(...span.map((t) => t.y0)),
    x1: Math.max(...span.map((t) => t.x1)),
    y1: Math.max(...span.map((t) => t.y1)),
    page: span[0].page,
  };
}

function spanText(span) {
  return span.map((t) => t.text).join(" ");
}

function similarityRatio(a, b) {
  if (a.length === 0 && b.length === 0) return 100;
  const dist = levenshteinDistance(a, b);
  return Math.round(((a.length + b.length - dist) / (a.length + b.length)) * 100);
}

function levenshteinDistance(a, b) {
  const dp = [];
  for (let i = 0; i <= a.length; i++) {
    dp.push(new Array(b.length + 1).fill(0));
    dp[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// mirrors blender.py's _format_ocr_only so output looks the same either way
function formatOcrOnly(keywords, ocrResults) {
  const lines = [
    "Document Title: [not available - OCR-only mode does not read titles]",
    "Document Type: [not available - OCR-only mode]",
    "keywords:",
    "",
  ];

  for (const keyword of keywords) {
    const match = ocrResults[keyword] || {};
    lines.push(`${keyword}: ${match.value ? match.value : "[not specified]"}`);
  }

  return lines.join("\n");
}

function renderResults(data) {
  const modeLabels = {
    full_ai: "complete AI",
    pure_ocr: "complete manual",
    hybrid: `hybrid, ${Math.round(data.bias_used * 100)}% AI`,
  };

  lastResult = data;
  ledgerMode.textContent = modeLabels[data.mode] || data.mode;
  ledgerBody.textContent = data.result;
  resultsSection.hidden = false;
}

function showStatus(message, isError) {
  statusLine.hidden = false;
  statusLine.textContent = message;
  statusLine.classList.toggle("status-line--error", isError);
}

// downloads. the ledger text is plain 'key: value' lines under a
// 'keywords:' marker, so it parses back easily enough for
// JSON and CSV.

document.getElementById("download-txt").addEventListener("click", () => {
  if (!lastResult) return;
  downloadFile(lastResult.result, "scan-results.txt", "text/plain");
});

document.getElementById("download-json").addEventListener("click", () => {
  if (!lastResult) return;
  const { meta, keywords } = parseResult(lastResult.result);
  const payload = { ...meta, mode: lastResult.mode, keywords };
  downloadFile(JSON.stringify(payload, null, 2), "scan-results.json", "application/json");
});

document.getElementById("download-csv").addEventListener("click", () => {
  if (!lastResult) return;
  const { keywords } = parseResult(lastResult.result);
  const rows = [["keyword", "value"], ...Object.entries(keywords)];
  const csv = rows.map((row) => row.map(csvField).join(",")).join("\n");
  downloadFile(csv, "scan-results.csv", "text/csv");
});

function parseResult(text) {
  const meta = {};
  const keywords = {};
  let inKeywords = false;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toLowerCase() === "keywords:") {
      inKeywords = true;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    (inKeywords ? keywords : meta)[key] = value;
  }

  return { meta, keywords };
}

function csvField(value) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}