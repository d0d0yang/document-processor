"""
ocr_engine.py

The manual half of the pipeline. This ver keeps each recognized keyword 
as an individual token with a bbox, and finds the region that best
matches the keyword, then looks at what's actually positioned next to
it / to the right on the same line / on the line underneath similar
to other ICRs

PyMuPDF provides native PDF text with word boxes, EasyOCR gives word 
boxes + confidence value for anything thatneeds actual processing.
"""

import os
from rapidfuzz import fuzz

import pymupdf
import easyocr
import numpy as np
from PIL import Image

# how close a token spans text must be to the keyword before considered
# as a match
LINE_MATCH_THRESHOLD = 60

# how many tokens of a valued region willing to pull back
CONTEXT_WINDOW = 6

# how much two tokens' vertical ranges overlap before being considered as 
# on the same visual line
LINE_OVERLAP_RATIO = 0.4

# how far past a matched keyword's right edge to still look for a
# value on the same line as a multiple of the label's own avg
# char width 
MAX_SAME_LINE_GAP_CHARS = 40

# dpi to rasterize a scanned PDF page at before handing it to the OCR
# reader
RASTER_DPI = 350

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".gif"}

# EasyOCR's Reader built lazily to maintain a single instance vs reloading 
# for every request
_ocr_reader = None


def _get_ocr_reader():
    global _ocr_reader
    if _ocr_reader is None:
        _ocr_reader = easyocr.Reader(["en"], gpu=False)
    return _ocr_reader


# pulling tokens

def get_tokens(file_path):
    """
    Return every recognized word in the document as its own token:

        {"text": str, "x0", "y0", "x1", "y1": float,
         "page": int, "confidence": 0-100}

    Coordinates are in PDF page-points for PDFs and pixels for standalone
    images - they only need to be internally consistent within a single
    document, since every comparison we make is between tokens from the
    same file.
    """
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".pdf":
        return _pdf_tokens(file_path)

    if ext in IMAGE_EXTENSIONS:
        image = Image.open(file_path).convert("RGB")
        return _ocr_tokens(image, page=0)

    if ext in (".txt", ".md"):
        return _plaintext_tokens(file_path)

    # unknown extension to be tried as plain text so to try not
    # to blow up same fallback the rest of the app uses
    try:
        return _plaintext_tokens(file_path)
    except Exception:
        return []


def _pdf_tokens(file_path):
    tokens = []
    doc = pymupdf.open(file_path)

    for page_number, page in enumerate(doc):
        # (x0, y0, x1, y1, text, block_no, line_no, word_no)
        words = page.get_text("words")

        if len(words) < 5:
            # basically an empty page which is probably a scan
            # with no text layer so rasterize it and OCR instead
            tokens.extend(_scanned_page_tokens(page, page_number))
            continue

        for x0, y0, x1, y1, text, *_ in words:
            tokens.append({
                "text": text,
                "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                "page": page_number,
                "confidence": 100,  # embedded text not a guess
            })

    doc.close()
    return tokens


def _scanned_page_tokens(page, page_number):
    pixmap = page.get_pixmap(dpi=RASTER_DPI, colorspace=pymupdf.csRGB, alpha=False)
    image = Image.frombytes("RGB", [pixmap.width, pixmap.height], pixmap.samples)

    # OCR runs in pixel space scaled at RASTER_DPI thus the resulting boxes
    # are scaled back down into page point size so this page's tokens match
    # tokens from a normal text-layer page
    scale = RASTER_DPI / 72.0
    tokens = _ocr_tokens(image, page=page_number)
    for token in tokens:
        token["x0"] /= scale
        token["y0"] /= scale
        token["x1"] /= scale
        token["y1"] /= scale
    return tokens


def _ocr_tokens(pil_image, page):
    reader = _get_ocr_reader()
    # detail=1, paragraph=False gets individual word boxes instead of
    # a flattened block of text
    raw = reader.readtext(np.array(pil_image), detail=1, paragraph=False)

    tokens = []
    for bbox, text, confidence in raw:
        xs = [point[0] for point in bbox]
        ys = [point[1] for point in bbox]
        tokens.append({
            "text": text,
            "x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys),
            "page": page,
            "confidence": round(confidence * 100),
        })
    return tokens


def _plaintext_tokens(file_path):
    """
    Plain text has no inherent layout, but can be faked for the same 
    spatial reasoning. Each line becomes a row (y = line number) and 
    each word's x position is its char offset in the line.
    """
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()

    tokens = []
    for line_number, line in enumerate(lines):
        cursor = 0
        for word in line.split():
            start = line.index(word, cursor)
            end = start + len(word)
            tokens.append({
                "text": word,
                "x0": start, "y0": line_number,
                "x1": end, "y1": line_number + 0.9,
                "page": 0,
                "confidence": 100,
            })
            cursor = end
    return tokens


# finding keywords from tokens

def find_keyword_matches(tokens, keywords):
    """
    For each keyword, find the token span that best matches it, then
    look at what's actually sitting next to that span to get a
    value. Start from the right of the same line then to the line
    underneath.
    """
    if not keywords:
        return {}

    if not tokens:
        return {k: {"value": None, "confidence": 0, "context": None} for k in keywords}

    reading_order = sorted(tokens, key=lambda t: (t["page"], t["y0"], t["x0"]))
    return {keyword: _best_match_for_keyword(keyword, reading_order) for keyword in keywords}


def _best_match_for_keyword(keyword, tokens):
    keyword_words = keyword.split()
    # try window the same length as keyword and one word longer
    # in case a stray character merged onto label
    window_sizes = {len(keyword_words), len(keyword_words) + 1}

    best_span = None
    best_score = 0

    for size in window_sizes:
        if size <= 0:
            continue
        for i in range(len(tokens) - size + 1):
            window = tokens[i:i + size]
            if window[0]["page"] != window[-1]["page"]:
                continue  # never let a match straddle two pages
            candidate = " ".join(t["text"] for t in window)
            score = fuzz.ratio(keyword.lower(), candidate.lower())
            if score > best_score:
                best_score = score
                best_span = window

    if best_score < LINE_MATCH_THRESHOLD or best_span is None:
        return {"value": None, "confidence": round(best_score), "context": None}

    label_box = _union_box(best_span)
    value_tokens = _find_value_tokens(tokens, best_span, label_box)

    if not value_tokens:
        return {
            "value": None,
            "confidence": round(best_score),
            "context": _span_text(best_span),
        }

    value_text = _span_text(value_tokens)
    return {
        "value": value_text,
        "confidence": round(best_score),
        "context": f"{_span_text(best_span)}  ->  {value_text}",
    }


def _find_value_tokens(tokens, label_span, label_box):
    excluded = {id(t) for t in label_span}
    label_height = (label_box["y1"] - label_box["y0"]) or 1
    max_gap = MAX_SAME_LINE_GAP_CHARS * _typical_char_width(label_span, label_box)

    # first, anything on the same line, on the right
    same_line = [
        t for t in tokens
        if id(t) not in excluded
        and t["page"] == label_box["page"]
        and t["x0"] >= label_box["x1"] - 1  # tiny tolerance for rounding
        and _same_line(t, label_box)
        and (t["x0"] - label_box["x1"]) < max_gap
    ]
    if same_line:
        same_line.sort(key=lambda t: t["x0"])
        return same_line[:CONTEXT_WINDOW]

    # afterwards check whether the value is glued onto the label's own last
    # word
    last_word = label_span[-1]["text"]
    for sep in (":", "-"):
        if sep in last_word:
            trailing = last_word.rsplit(sep, 1)[-1].strip()
            if trailing:
                return [{
                    "text": trailing,
                    "x0": label_box["x1"], "y0": label_box["y0"],
                    "x1": label_box["x1"], "y1": label_box["y1"],
                    "page": label_box["page"],
                }]

    # if nothing beside fall back to the line underneath
    below = sorted(
        (t for t in tokens
         if id(t) not in excluded
         and t["page"] == label_box["page"]
         and t["y0"] >= label_box["y1"] - (label_height * 0.2)),
        key=lambda t: (t["y0"], t["x0"]),
    )
    if not below:
        return []

    first_line_band = {"y0": below[0]["y0"], "y1": below[0]["y1"]}
    next_line = [t for t in below if _same_line(t, first_line_band)]
    return next_line[:CONTEXT_WINDOW]


def _typical_char_width(label_span, label_box):
    total_chars = sum(len(t["text"]) for t in label_span) or 1
    width = (label_box["x1"] - label_box["x0"]) or total_chars
    char_width = width / total_chars
    return char_width if char_width > 0 else 1


def _same_line(token, band):
    token_height = (token["y1"] - token["y0"]) or 1
    band_height = (band["y1"] - band["y0"]) or token_height
    overlap = min(token["y1"], band["y1"]) - max(token["y0"], band["y0"])
    return overlap > LINE_OVERLAP_RATIO * min(token_height, band_height)


def _union_box(span):
    return {
        "x0": min(t["x0"] for t in span),
        "y0": min(t["y0"] for t in span),
        "x1": max(t["x1"] for t in span),
        "y1": max(t["y1"] for t in span),
        "page": span[0]["page"],
    }


def _span_text(span):
    return " ".join(t["text"] for t in span)