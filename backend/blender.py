"""
blender.py

Flask provides file + keywords + prompt + bias, and decides how much and of 
which engine actually gets to answer.

Rules:
  - no keywords  |  bias is forced to 1.0 (full AI), OCR is skipped entirely
  - keywords, bias == 0.0  |  pure OCR, API call is skipped
  - keywords, bias != 0.0 -> OCR runs first to generate keyword candidates,
                                then Gemini gets those candidates and a bias
                                score to measure confidence of candidates
"""

from datetime import datetime

import ocr_engine
import ai_engine

PURE_OCR_THRESHOLD = 0.0


def process_document(file_path, keywords, user_prompt, bias):
    keywords = [k.strip() for k in keywords if k.strip()] if keywords else []
    has_keywords = bool(keywords)

    if not has_keywords:
        # no keyword rule
        ai_text = ai_engine.call_gemini(
            file_path, user_prompt, keywords=[], ocr_results=None, bias=1.0
        )
        return {
            "mode": "full_ai",
            "bias_used": 1.0,
            "result": ai_text,
        }

    tokens = ocr_engine.get_tokens(file_path)
    ocr_results = ocr_engine.find_keyword_matches(tokens, keywords)

    if bias <= PURE_OCR_THRESHOLD:
        # OCR only rule
        return {
            "mode": "pure_ocr",
            "bias_used": 0.0,
            "result": _format_ocr_only(keywords, ocr_results),
        }

    ai_text = ai_engine.call_gemini(
        file_path, user_prompt, keywords, ocr_results, bias
    )
    return {
        "mode": "hybrid",
        "bias_used": bias,
        "result": ai_text,
    }


def _format_ocr_only(keywords, ocr_results):
    """
    Match the same "keyword: value" shape the AI path returns, so the
    frontend doesn't need two different renderers.
    """
    lines = [
        f"Document Title: [not available - OCR-only mode does not read titles]",
        f"Document Type: [not available - OCR-only mode]",
        "keywords:",
        "",
    ]

    for keyword in keywords:
        match = ocr_results.get(keyword, {})
        value = match.get("value")
        lines.append(f"{keyword}: {value if value else '[not specified]'}")

    return "\n".join(lines)